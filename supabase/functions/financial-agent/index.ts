/**
 * FoodHub V3 — Financial Agent
 * Gerencia o ciclo de vida de comissoes no marketplace B2B.
 *
 * Acoes:
 *   calcular_comissao   — Calcula splits ao fechar negocio
 *   verificar_liquidacao — Checa confirmacoes de pagamento das partes
 *   alertar_vencimento   — Alerta vencimentos proximos e inadimplencia
 *   confirmar_pagamento  — Marca comissao como paga
 *   resumo_financeiro    — Dashboard consolidado para mesa
 *
 * Regras:
 *   - Comissao NUNCA e visivel ao comprador
 *   - Comissao so e discutida com fornecedor no contexto do acordo
 *   - Todos os valores em BRL (R$)
 *   - Todas as acoes registradas em ia_logs
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  supabase,
  chamarClaude,
  criarAprovacao,
  logIA,
  jsonResponse,
  corsResponse,
  CORS_HEADERS,
  gerarCodigo,
} from "../_shared/config.ts";

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

interface FinancialRequest {
  acao: string;
  pedido_id?: string;
  dados?: Record<string, unknown>;
}

interface AcordoComercial {
  id: string;
  fornecedor_id: string;
  comissao_total_pct: number;
  mesa_pct: number;
  originador_pct: number;
  seller_pct: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function brl(valor: number): string {
  return `R$ ${valor.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function diasEntre(a: Date, b: Date): number {
  const ms = b.getTime() - a.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

// ---------------------------------------------------------------------------
// 1. calcular_comissao
// ---------------------------------------------------------------------------

async function calcularComissao(pedidoId: string): Promise<Response> {
  const inicio = Date.now();

  // Buscar pedido
  const { data: pedido, error: errPedido } = await supabase
    .from("pedidos_v2")
    .select("*")
    .eq("id", pedidoId)
    .single();

  if (errPedido || !pedido) {
    await logIA("financial-agent", null, "api", pedidoId, "Pedido nao encontrado", "calcular_comissao", "erro", false, Date.now() - inicio);
    return jsonResponse({ erro: "Pedido nao encontrado", detalhe: errPedido?.message }, 404);
  }

  const valorNegocio: number = pedido.valor_negocio;
  if (!valorNegocio || valorNegocio <= 0) {
    await logIA("financial-agent", null, "api", pedidoId, "Valor de negocio invalido", "calcular_comissao", "erro", false, Date.now() - inicio);
    return jsonResponse({ erro: "Valor de negocio invalido no pedido" }, 400);
  }

  // Buscar acordo comercial do fornecedor
  const { data: acordo, error: errAcordo } = await supabase
    .from("acordos_comerciais")
    .select("*")
    .eq("fornecedor_id", pedido.fornecedor_id)
    .eq("status", "ativo")
    .order("criado_em", { ascending: false })
    .limit(1)
    .single();

  if (errAcordo || !acordo) {
    await logIA("financial-agent", null, "api", pedidoId, "Acordo comercial nao encontrado", "calcular_comissao", "erro", false, Date.now() - inicio);
    return jsonResponse({ erro: "Acordo comercial ativo nao encontrado para o fornecedor" }, 404);
  }

  const ac = acordo as AcordoComercial;

  // Calcular splits
  const comissaoTotal = valorNegocio * (ac.comissao_total_pct / 100);
  const mesaValor = comissaoTotal * (ac.mesa_pct / 100);
  const originadorValor = comissaoTotal * (ac.originador_pct / 100);
  const sellerValor = comissaoTotal * (ac.seller_pct / 100);

  // Gerar codigo
  const codigo = await gerarCodigo("COM", "financials_v2");

  // Calcular vencimento (D+30 padrao)
  const vencimento = new Date();
  vencimento.setDate(vencimento.getDate() + 30);

  // Salvar em financials_v2
  const { data: financial, error: errInsert } = await supabase
    .from("financials_v2")
    .insert({
      codigo,
      pedido_id: pedidoId,
      fornecedor_id: pedido.fornecedor_id,
      originador_id: pedido.originador_id || null,
      seller_id: pedido.seller_id || null,
      acordo_id: ac.id,
      valor_negocio: valorNegocio,
      comissao_total_pct: ac.comissao_total_pct,
      comissao_total: comissaoTotal,
      mesa_valor: mesaValor,
      originador_valor: originadorValor,
      seller_valor: sellerValor,
      status: "calculada",
      vencimento_comissao: vencimento.toISOString(),
      liquidacao_cliente_confirmada: false,
      liquidacao_fornecedor_confirmada: false,
      criado_em: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (errInsert || !financial) {
    await logIA("financial-agent", null, "api", pedidoId, `Erro ao salvar: ${errInsert?.message}`, "calcular_comissao", "erro", false, Date.now() - inicio);
    return jsonResponse({ erro: "Erro ao salvar comissao", detalhe: errInsert?.message }, 500);
  }

  // Criar aprovacao para mesa
  await criarAprovacao("comissao", financial.id, codigo);

  // Notificar mesa
  const { data: mesa } = await supabase
    .from("members")
    .select("id")
    .eq("tipo", "mesa")
    .eq("status", "ativo");

  if (mesa?.length) {
    const notificacoes = mesa.map((m: { id: string }) => ({
      member_id: m.id,
      tipo: "comissao_calculada",
      titulo: `Comissao ${codigo} calculada`,
      mensagem: `Pedido ${pedidoId} — Valor negocio: ${brl(valorNegocio)} | Comissao total: ${brl(comissaoTotal)} (${ac.comissao_total_pct}%). Mesa: ${brl(mesaValor)} | Originador: ${brl(originadorValor)} | Seller: ${brl(sellerValor)}`,
      canal: "dashboard",
      acao_requerida: true,
      acao_tipo: "APROVAR",
      acao_codigo: codigo,
      criado_em: new Date().toISOString(),
    }));
    await supabase.from("notificacoes_v2").insert(notificacoes);
  }

  await logIA("financial-agent", null, "api", pedidoId, `Comissao ${codigo} calculada: ${brl(comissaoTotal)}`, "calcular_comissao", "calcular_comissao", true, Date.now() - inicio);

  return jsonResponse({
    sucesso: true,
    codigo,
    financial_id: financial.id,
    valor_negocio: valorNegocio,
    comissao_total: comissaoTotal,
    mesa_valor: mesaValor,
    originador_valor: originadorValor,
    seller_valor: sellerValor,
    vencimento: vencimento.toISOString(),
  });
}

// ---------------------------------------------------------------------------
// 2. verificar_liquidacao
// ---------------------------------------------------------------------------

async function verificarLiquidacao(): Promise<Response> {
  const inicio = Date.now();

  // Buscar financials com ambas confirmacoes
  const { data: confirmados, error: errQuery } = await supabase
    .from("financials_v2")
    .select("*")
    .eq("liquidacao_cliente_confirmada", true)
    .eq("liquidacao_fornecedor_confirmada", true)
    .eq("status", "calculada");

  if (errQuery) {
    await logIA("financial-agent", null, "api", "verificar_liquidacao", `Erro: ${errQuery.message}`, "verificar_liquidacao", "erro", false, Date.now() - inicio);
    return jsonResponse({ erro: "Erro ao consultar financials", detalhe: errQuery.message }, 500);
  }

  if (!confirmados?.length) {
    await logIA("financial-agent", null, "api", "verificar_liquidacao", "Nenhuma liquidacao pendente", "verificar_liquidacao", "verificar_liquidacao", true, Date.now() - inicio);
    return jsonResponse({ sucesso: true, mensagem: "Nenhuma liquidacao pendente de cobranca", total: 0 });
  }

  const resultados: Array<{ codigo: string; status: string }> = [];

  for (const fin of confirmados) {
    // Atualizar status para cobrada
    await supabase
      .from("financials_v2")
      .update({
        status: "cobrada",
        cobrada_em: new Date().toISOString(),
      })
      .eq("id", fin.id);

    // Notificar fornecedor com valor e vencimento
    if (fin.fornecedor_id) {
      const vencimentoDate = fin.vencimento_comissao
        ? new Date(fin.vencimento_comissao).toLocaleDateString("pt-BR")
        : "a definir";

      await supabase.from("notificacoes_v2").insert({
        member_id: fin.fornecedor_id,
        tipo: "boleto_comissao",
        titulo: `Comissao ${fin.codigo} — Boleto gerado`,
        mensagem: `Sua comissao de ${brl(fin.comissao_total)} referente ao pedido foi confirmada. Vencimento: ${vencimentoDate}. O boleto sera enviado em breve.`,
        canal: "whatsapp",
        acao_requerida: false,
        criado_em: new Date().toISOString(),
      });
    }

    resultados.push({ codigo: fin.codigo, status: "cobrada" });
  }

  await logIA("financial-agent", null, "api", "verificar_liquidacao", `${resultados.length} comissoes atualizadas para cobrada`, "verificar_liquidacao", "verificar_liquidacao", true, Date.now() - inicio);

  return jsonResponse({
    sucesso: true,
    total: resultados.length,
    atualizados: resultados,
  });
}

// ---------------------------------------------------------------------------
// 3. alertar_vencimento
// ---------------------------------------------------------------------------

async function alertarVencimento(): Promise<Response> {
  const inicio = Date.now();
  const hoje = new Date();
  const em5dias = new Date();
  em5dias.setDate(hoje.getDate() + 5);

  // Comissoes com vencimento proximo (dentro de 5 dias)
  const { data: proximos, error: errProx } = await supabase
    .from("financials_v2")
    .select("*")
    .in("status", ["calculada", "cobrada"])
    .lte("vencimento_comissao", em5dias.toISOString())
    .gte("vencimento_comissao", hoje.toISOString());

  if (errProx) {
    await logIA("financial-agent", null, "api", "alertar_vencimento", `Erro: ${errProx.message}`, "alertar_vencimento", "erro", false, Date.now() - inicio);
    return jsonResponse({ erro: "Erro ao consultar vencimentos", detalhe: errProx.message }, 500);
  }

  let alertasEnviados = 0;

  // Alertar fornecedores sobre vencimentos proximos
  if (proximos?.length) {
    for (const fin of proximos) {
      if (!fin.fornecedor_id) continue;

      const vencimentoDate = new Date(fin.vencimento_comissao).toLocaleDateString("pt-BR");
      const diasRestantes = diasEntre(hoje, new Date(fin.vencimento_comissao));

      await supabase.from("notificacoes_v2").insert({
        member_id: fin.fornecedor_id,
        tipo: "alerta_vencimento_comissao",
        titulo: `Comissao ${fin.codigo} vence em ${diasRestantes} dia(s)`,
        mensagem: `Sua comissao de ${brl(fin.comissao_total)} vence em ${vencimentoDate}. Por favor, providencie o pagamento para evitar inadimplencia.`,
        canal: "whatsapp",
        acao_requerida: true,
        acao_tipo: "PAGAR",
        acao_codigo: fin.codigo,
        criado_em: new Date().toISOString(),
      });
      alertasEnviados++;
    }
  }

  // D+35 — comissoes vencidas ha mais de 5 dias: marcar como inadimplente
  const d35 = new Date();
  d35.setDate(hoje.getDate() - 5);

  const { data: vencidos, error: errVenc } = await supabase
    .from("financials_v2")
    .select("*")
    .in("status", ["calculada", "cobrada"])
    .lt("vencimento_comissao", d35.toISOString());

  let inadimplentes = 0;

  if (!errVenc && vencidos?.length) {
    for (const fin of vencidos) {
      // Atualizar para inadimplente
      await supabase
        .from("financials_v2")
        .update({
          status: "inadimplente",
          inadimplente_em: new Date().toISOString(),
        })
        .eq("id", fin.id);

      // Alertar mesa para escalacao juridica
      const { data: mesa } = await supabase
        .from("members")
        .select("id")
        .eq("tipo", "mesa")
        .eq("status", "ativo");

      if (mesa?.length) {
        const notificacoes = mesa.map((m: { id: string }) => ({
          member_id: m.id,
          tipo: "inadimplencia_comissao",
          titulo: `INADIMPLENTE: Comissao ${fin.codigo}`,
          mensagem: `Comissao ${fin.codigo} de ${brl(fin.comissao_total)} do fornecedor ${fin.fornecedor_id} esta inadimplente. Vencimento original: ${new Date(fin.vencimento_comissao).toLocaleDateString("pt-BR")}. Escalacao juridica recomendada.`,
          canal: "dashboard",
          acao_requerida: true,
          acao_tipo: "ESCALAR_JURIDICO",
          acao_codigo: fin.codigo,
          criado_em: new Date().toISOString(),
        }));
        await supabase.from("notificacoes_v2").insert(notificacoes);
      }

      inadimplentes++;
    }
  }

  await logIA("financial-agent", null, "api", "alertar_vencimento", `Alertas: ${alertasEnviados}, Inadimplentes: ${inadimplentes}`, "alertar_vencimento", "alertar_vencimento", true, Date.now() - inicio);

  return jsonResponse({
    sucesso: true,
    alertas_enviados: alertasEnviados,
    inadimplentes_marcados: inadimplentes,
    proximos_vencimento: proximos?.length || 0,
    vencidos_total: vencidos?.length || 0,
  });
}

// ---------------------------------------------------------------------------
// 4. confirmar_pagamento
// ---------------------------------------------------------------------------

async function confirmarPagamento(dados: Record<string, unknown>): Promise<Response> {
  const inicio = Date.now();
  const financialId = dados.financial_id as string;

  if (!financialId) {
    return jsonResponse({ erro: "financial_id e obrigatorio" }, 400);
  }

  const { data: fin, error: errFin } = await supabase
    .from("financials_v2")
    .select("*")
    .eq("id", financialId)
    .single();

  if (errFin || !fin) {
    await logIA("financial-agent", null, "api", financialId, "Financial nao encontrado", "confirmar_pagamento", "erro", false, Date.now() - inicio);
    return jsonResponse({ erro: "Registro financeiro nao encontrado" }, 404);
  }

  if (fin.status === "paga") {
    return jsonResponse({ erro: "Comissao ja esta marcada como paga" }, 409);
  }

  const agora = new Date().toISOString();

  const { error: errUpdate } = await supabase
    .from("financials_v2")
    .update({
      status: "paga",
      pago_em: agora,
    })
    .eq("id", financialId);

  if (errUpdate) {
    await logIA("financial-agent", null, "api", financialId, `Erro ao atualizar: ${errUpdate.message}`, "confirmar_pagamento", "erro", false, Date.now() - inicio);
    return jsonResponse({ erro: "Erro ao confirmar pagamento", detalhe: errUpdate.message }, 500);
  }

  await logIA("financial-agent", null, "api", financialId, `Comissao ${fin.codigo} marcada como paga`, "confirmar_pagamento", "confirmar_pagamento", true, Date.now() - inicio);

  return jsonResponse({
    sucesso: true,
    codigo: fin.codigo,
    status: "paga",
    pago_em: agora,
    valor: fin.comissao_total,
  });
}

// ---------------------------------------------------------------------------
// 5. resumo_financeiro
// ---------------------------------------------------------------------------

async function resumoFinanceiro(): Promise<Response> {
  const inicio = Date.now();

  // Totais por status
  const statusList = ["calculada", "cobrada", "paga", "inadimplente"];
  const totais: Record<string, { count: number; valor: number }> = {};

  for (const status of statusList) {
    const { data, error } = await supabase
      .from("financials_v2")
      .select("comissao_total")
      .eq("status", status);

    if (error) {
      totais[status] = { count: 0, valor: 0 };
      continue;
    }

    const registros = data || [];
    totais[status] = {
      count: registros.length,
      valor: registros.reduce((sum: number, r: { comissao_total: number }) => sum + (r.comissao_total || 0), 0),
    };
  }

  // Breakdown por originador
  const { data: porOriginador } = await supabase
    .from("financials_v2")
    .select("originador_id, originador_valor, status")
    .not("originador_id", "is", null);

  const originadorMap: Record<string, { total: number; count: number }> = {};
  if (porOriginador?.length) {
    for (const r of porOriginador) {
      const key = r.originador_id;
      if (!originadorMap[key]) originadorMap[key] = { total: 0, count: 0 };
      originadorMap[key].total += r.originador_valor || 0;
      originadorMap[key].count++;
    }
  }

  // Breakdown por seller
  const { data: porSeller } = await supabase
    .from("financials_v2")
    .select("seller_id, seller_valor, status")
    .not("seller_id", "is", null);

  const sellerMap: Record<string, { total: number; count: number }> = {};
  if (porSeller?.length) {
    for (const r of porSeller) {
      const key = r.seller_id;
      if (!sellerMap[key]) sellerMap[key] = { total: 0, count: 0 };
      sellerMap[key].total += r.seller_valor || 0;
      sellerMap[key].count++;
    }
  }

  // Montar texto formatado
  let texto = "=== RESUMO FINANCEIRO FOODHUB ===\n\n";

  texto += "COMISSOES POR STATUS:\n";
  texto += `  Pendentes (calculada): ${totais.calculada.count} — ${brl(totais.calculada.valor)}\n`;
  texto += `  Cobradas:              ${totais.cobrada.count} — ${brl(totais.cobrada.valor)}\n`;
  texto += `  Pagas:                 ${totais.paga.count} — ${brl(totais.paga.valor)}\n`;
  texto += `  Inadimplentes:         ${totais.inadimplente.count} — ${brl(totais.inadimplente.valor)}\n`;

  const totalGeral = statusList.reduce((s, k) => s + totais[k].valor, 0);
  const totalCount = statusList.reduce((s, k) => s + totais[k].count, 0);
  texto += `\n  TOTAL GERAL: ${totalCount} comissoes — ${brl(totalGeral)}\n`;

  if (Object.keys(originadorMap).length > 0) {
    texto += "\nBREAKDOWN POR ORIGINADOR:\n";
    for (const [id, info] of Object.entries(originadorMap)) {
      texto += `  ${id}: ${info.count} comissoes — ${brl(info.total)}\n`;
    }
  }

  if (Object.keys(sellerMap).length > 0) {
    texto += "\nBREAKDOWN POR SELLER:\n";
    for (const [id, info] of Object.entries(sellerMap)) {
      texto += `  ${id}: ${info.count} comissoes — ${brl(info.total)}\n`;
    }
  }

  await logIA("financial-agent", null, "api", "resumo_financeiro", `Resumo gerado: ${totalCount} comissoes`, "resumo_financeiro", "resumo_financeiro", true, Date.now() - inicio);

  return jsonResponse({
    sucesso: true,
    resumo: texto,
    dados: {
      totais,
      total_geral: { count: totalCount, valor: totalGeral },
      por_originador: originadorMap,
      por_seller: sellerMap,
    },
  });
}

// ---------------------------------------------------------------------------
// Handler HTTP
// ---------------------------------------------------------------------------

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return corsResponse();
  }

  if (req.method !== "POST") {
    return jsonResponse({ erro: "Metodo nao permitido. Use POST." }, 405);
  }

  try {
    const body: FinancialRequest = await req.json();
    const { acao, pedido_id, dados } = body;

    if (!acao) {
      return jsonResponse({ erro: "Campo 'acao' e obrigatorio" }, 400);
    }

    console.log(`[financial-agent] acao=${acao} pedido_id=${pedido_id || "N/A"}`);

    switch (acao) {
      case "calcular_comissao": {
        if (!pedido_id) {
          return jsonResponse({ erro: "pedido_id e obrigatorio para calcular_comissao" }, 400);
        }
        return await calcularComissao(pedido_id);
      }

      case "verificar_liquidacao":
        return await verificarLiquidacao();

      case "alertar_vencimento":
        return await alertarVencimento();

      case "confirmar_pagamento": {
        if (!dados) {
          return jsonResponse({ erro: "dados e obrigatorio para confirmar_pagamento (financial_id)" }, 400);
        }
        return await confirmarPagamento(dados);
      }

      case "resumo_financeiro":
        return await resumoFinanceiro();

      default:
        return jsonResponse({
          erro: `Acao desconhecida: ${acao}`,
          acoes_disponiveis: [
            "calcular_comissao",
            "verificar_liquidacao",
            "alertar_vencimento",
            "confirmar_pagamento",
            "resumo_financeiro",
          ],
        }, 400);
    }
  } catch (err) {
    console.error("[financial-agent] Erro:", err);
    return jsonResponse(
      { erro: "Erro interno do agente financeiro", detalhe: String(err) },
      500
    );
  }
});
