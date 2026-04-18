/**
 * FoodHub V3 — Ops Agent (Operations Automation)
 *
 * Agente de automacao operacional. Roda verificacoes de SLA,
 * follow-ups automaticos, cobrancas e gera resumo diario para a mesa.
 *
 * Chamado periodicamente via cron ou trigger manual.
 * POST { acao: "run_all" | "verificar_sla_propostas" | ... }
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  supabase,
  chamarClaude,
  logIA,
  jsonResponse,
  corsResponse,
  CORS_HEADERS,
} from "../_shared/config.ts";

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

interface OpsRequest {
  acao: string;
}

interface ActionResult {
  acao: string;
  sucesso: boolean;
  resumo: string;
  detalhes: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helpers de tempo (UTC)
// ---------------------------------------------------------------------------

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function horasDesde(isoDate: string): number {
  return (Date.now() - new Date(isoDate).getTime()) / HOUR_MS;
}

function diasDesde(isoDate: string): number {
  return (Date.now() - new Date(isoDate).getTime()) / DAY_MS;
}

// ---------------------------------------------------------------------------
// Notificacao helper
// ---------------------------------------------------------------------------

async function criarNotificacao(
  memberId: string,
  tipo: string,
  titulo: string,
  mensagem: string,
  canal: string,
  acaoRequerida = false,
  acaoTipo: string | null = null,
  acaoCodigo: string | null = null,
): Promise<void> {
  await supabase.from("notificacoes_v2").insert({
    member_id: memberId,
    tipo,
    titulo,
    mensagem,
    canal,
    acao_requerida: acaoRequerida,
    acao_tipo: acaoTipo,
    acao_codigo: acaoCodigo,
    criado_em: new Date().toISOString(),
  });
}

async function notificarMesa(
  tipo: string,
  titulo: string,
  mensagem: string,
  acaoRequerida = false,
  acaoTipo: string | null = null,
  acaoCodigo: string | null = null,
): Promise<void> {
  const { data: mesa } = await supabase
    .from("members")
    .select("id")
    .eq("tipo", "mesa")
    .eq("status", "ativo");

  if (!mesa?.length) return;

  const notificacoes = mesa.map((m: { id: string }) => ({
    member_id: m.id,
    tipo,
    titulo,
    mensagem,
    canal: "dashboard",
    acao_requerida: acaoRequerida,
    acao_tipo: acaoTipo,
    acao_codigo: acaoCodigo,
    criado_em: new Date().toISOString(),
  }));

  await supabase.from("notificacoes_v2").insert(notificacoes);
}

async function log(
  input: string,
  output: string,
  intencao: string,
  acao: string,
  sucesso: boolean,
  tempoMs: number,
): Promise<void> {
  await logIA(
    "ops_agent",
    null,
    "cron",
    input,
    output,
    intencao,
    acao,
    sucesso,
    tempoMs,
  );
}

// ---------------------------------------------------------------------------
// 1. verificar_sla_propostas
// ---------------------------------------------------------------------------

async function verificarSlaPropostas(): Promise<ActionResult> {
  const inicio = Date.now();
  let nudges = 0;
  let alertas = 0;

  try {
    // Demandas ativas
    const { data: demandas, error: errD } = await supabase
      .from("demandas_v2")
      .select("id, codigo, produto, volume, regiao, criado_em")
      .eq("status", "ativa");

    if (errD) throw errD;
    if (!demandas?.length) {
      await log("verificar_sla_propostas", "Nenhuma demanda ativa", "sla_check", "nenhuma_acao", true, Date.now() - inicio);
      return { acao: "verificar_sla_propostas", sucesso: true, resumo: "Nenhuma demanda ativa.", detalhes: { nudges: 0, alertas: 0 } };
    }

    // Verificar quais demandas tem propostas
    const demandaIds = demandas.map((d: { id: string }) => d.id);
    const { data: propostas } = await supabase
      .from("propostas_v2")
      .select("demanda_id")
      .in("demanda_id", demandaIds);

    const demandaIdsComProposta = new Set(
      (propostas || []).map((p: { demanda_id: string }) => p.demanda_id),
    );

    const semProposta = demandas.filter(
      (d: { id: string }) => !demandaIdsComProposta.has(d.id),
    );

    for (const d of semProposta) {
      const horas = horasDesde(d.criado_em);

      if (horas > 48) {
        // Alertar mesa — sem propostas ha 48h
        await notificarMesa(
          "sla_proposta_critico",
          `SLA critico: ${d.codigo}`,
          `Demanda ${d.codigo} sem propostas ha 48h. Acionar fornecedores manualmente?`,
          true,
          "ACIONAR_FORNECEDORES",
          d.codigo,
        );
        alertas++;

        await log(
          `verificar_sla_propostas: ${d.codigo}`,
          `Alerta mesa — ${d.codigo} sem propostas ha ${Math.floor(horas)}h`,
          "sla_check",
          "alerta_mesa_48h",
          true,
          Date.now() - inicio,
        );
      } else if (horas > 24) {
        // Buscar fornecedores matchados para nudge
        const { data: matches } = await supabase
          .from("matches_v2")
          .select("fornecedor_id")
          .eq("demanda_id", d.id);

        if (matches?.length) {
          for (const match of matches) {
            await criarNotificacao(
              match.fornecedor_id,
              "sla_nudge",
              "Nova oportunidade disponivel",
              `Voce tem uma oportunidade de ${d.produto} ${d.volume || ""} em ${d.regiao || "sua regiao"}. Tem interesse em enviar proposta?`,
              "whatsapp",
            );
            nudges++;
          }
        }

        await log(
          `verificar_sla_propostas: ${d.codigo}`,
          `Nudge enviado — ${d.codigo} >24h, ${matches?.length || 0} fornecedores`,
          "sla_check",
          "nudge_fornecedores_24h",
          true,
          Date.now() - inicio,
        );
      }
    }

    const resumo = `SLA propostas: ${semProposta.length} demandas sem proposta, ${nudges} nudges, ${alertas} alertas mesa.`;
    await log("verificar_sla_propostas", resumo, "sla_check", "verificacao_completa", true, Date.now() - inicio);

    return { acao: "verificar_sla_propostas", sucesso: true, resumo, detalhes: { semProposta: semProposta.length, nudges, alertas } };
  } catch (err) {
    const msg = `Erro: ${String(err)}`;
    await log("verificar_sla_propostas", msg, "sla_check", "erro", false, Date.now() - inicio);
    return { acao: "verificar_sla_propostas", sucesso: false, resumo: msg, detalhes: {} };
  }
}

// ---------------------------------------------------------------------------
// 2. verificar_negociacoes_paradas
// ---------------------------------------------------------------------------

async function verificarNegociacoesParadas(): Promise<ActionResult> {
  const inicio = Date.now();
  let followUps = 0;

  try {
    const { data: negs, error: errN } = await supabase
      .from("negociacoes_v2")
      .select("id, codigo, comprador_id, fornecedor_id, produto")
      .eq("status", "em_andamento");

    if (errN) throw errN;
    if (!negs?.length) {
      await log("verificar_negociacoes_paradas", "Nenhuma negociacao em andamento", "neg_check", "nenhuma_acao", true, Date.now() - inicio);
      return { acao: "verificar_negociacoes_paradas", sucesso: true, resumo: "Nenhuma negociacao em andamento.", detalhes: { followUps: 0 } };
    }

    for (const neg of negs) {
      // Ultima mensagem da negociacao
      const { data: ultimaMsg } = await supabase
        .from("mensagens_v2")
        .select("criado_em")
        .eq("negociacao_id", neg.id)
        .order("criado_em", { ascending: false })
        .limit(1);

      const ultimoTimestamp = ultimaMsg?.[0]?.criado_em;
      if (!ultimoTimestamp) continue;

      const horas = horasDesde(ultimoTimestamp);
      if (horas <= 12) continue;

      // Follow-up para comprador (nunca expor dados do fornecedor)
      await criarNotificacao(
        neg.comprador_id,
        "negociacao_followup",
        "Negociacao aguardando",
        `${neg.produto} — tem alguma duvida sobre a proposta? Posso ajudar na negociacao.`,
        "whatsapp",
      );

      // Follow-up para fornecedor (nunca expor dados do comprador)
      await criarNotificacao(
        neg.fornecedor_id,
        "negociacao_followup",
        "Negociacao aguardando",
        `${neg.produto} — o comprador esta analisando. Quer ajustar alguma condicao?`,
        "whatsapp",
      );

      followUps++;

      await log(
        `verificar_negociacoes_paradas: ${neg.codigo}`,
        `Follow-up enviado — ${neg.codigo} parada ha ${Math.floor(horas)}h`,
        "neg_check",
        "followup_enviado",
        true,
        Date.now() - inicio,
      );
    }

    const resumo = `Negociacoes paradas: ${followUps} follow-ups enviados de ${negs.length} em andamento.`;
    await log("verificar_negociacoes_paradas", resumo, "neg_check", "verificacao_completa", true, Date.now() - inicio);

    return { acao: "verificar_negociacoes_paradas", sucesso: true, resumo, detalhes: { total: negs.length, followUps } };
  } catch (err) {
    const msg = `Erro: ${String(err)}`;
    await log("verificar_negociacoes_paradas", msg, "neg_check", "erro", false, Date.now() - inicio);
    return { acao: "verificar_negociacoes_paradas", sucesso: false, resumo: msg, detalhes: {} };
  }
}

// ---------------------------------------------------------------------------
// 3. verificar_comissoes_vencidas
// ---------------------------------------------------------------------------

async function verificarComissoesVencidas(): Promise<ActionResult> {
  const inicio = Date.now();
  let lembretes = 0;
  let inadimplentes = 0;

  try {
    const agora = new Date().toISOString();

    const { data: comissoes, error: errC } = await supabase
      .from("financials_v2")
      .select("id, codigo, fornecedor_id, valor_comissao, vencimento_comissao, pedido_codigo")
      .eq("status", "cobrada")
      .lt("vencimento_comissao", agora);

    if (errC) throw errC;
    if (!comissoes?.length) {
      await log("verificar_comissoes_vencidas", "Nenhuma comissao vencida", "comissao_check", "nenhuma_acao", true, Date.now() - inicio);
      return { acao: "verificar_comissoes_vencidas", sucesso: true, resumo: "Nenhuma comissao vencida.", detalhes: { lembretes: 0, inadimplentes: 0 } };
    }

    for (const c of comissoes) {
      const diasAtraso = diasDesde(c.vencimento_comissao);
      const dataVenc = new Date(c.vencimento_comissao).toLocaleDateString("pt-BR");
      const valorFmt = Number(c.valor_comissao).toLocaleString("pt-BR", { minimumFractionDigits: 2 });

      if (diasAtraso >= 35) {
        // Inadimplente — atualizar status e escalar para juridico
        await supabase
          .from("financials_v2")
          .update({ status: "inadimplente", atualizado_em: new Date().toISOString() })
          .eq("id", c.id);

        await notificarMesa(
          "comissao_inadimplente",
          `ALERTA: Comissao inadimplente ${c.codigo}`,
          `ALERTA: Comissao ${c.codigo} inadimplente ha ${Math.floor(diasAtraso)} dias. Valor: R$${valorFmt}. Escalar para juridico?`,
          true,
          "ESCALAR_JURIDICO",
          c.codigo,
        );

        inadimplentes++;

        await log(
          `verificar_comissoes_vencidas: ${c.codigo}`,
          `Inadimplente — ${c.codigo} ha ${Math.floor(diasAtraso)} dias, escalado`,
          "comissao_check",
          "marcar_inadimplente",
          true,
          Date.now() - inicio,
        );
      } else {
        // Lembrete ao fornecedor (comissao nunca visivel ao comprador)
        await criarNotificacao(
          c.fornecedor_id,
          "comissao_lembrete",
          "Lembrete de comissao",
          `Lembrete: comissao de R$${valorFmt} ref. pedido ${c.pedido_codigo} venceu em ${dataVenc}. Favor regularizar.`,
          "whatsapp",
        );

        lembretes++;

        await log(
          `verificar_comissoes_vencidas: ${c.codigo}`,
          `Lembrete enviado — ${c.codigo} vencida ha ${Math.floor(diasAtraso)} dias`,
          "comissao_check",
          "lembrete_enviado",
          true,
          Date.now() - inicio,
        );
      }
    }

    const resumo = `Comissoes vencidas: ${comissoes.length} total, ${lembretes} lembretes, ${inadimplentes} inadimplentes.`;
    await log("verificar_comissoes_vencidas", resumo, "comissao_check", "verificacao_completa", true, Date.now() - inicio);

    return { acao: "verificar_comissoes_vencidas", sucesso: true, resumo, detalhes: { total: comissoes.length, lembretes, inadimplentes } };
  } catch (err) {
    const msg = `Erro: ${String(err)}`;
    await log("verificar_comissoes_vencidas", msg, "comissao_check", "erro", false, Date.now() - inicio);
    return { acao: "verificar_comissoes_vencidas", sucesso: false, resumo: msg, detalhes: {} };
  }
}

// ---------------------------------------------------------------------------
// 4. verificar_tracking_atrasado
// ---------------------------------------------------------------------------

async function verificarTrackingAtrasado(): Promise<ActionResult> {
  const inicio = Date.now();
  let notificados = 0;
  let alertasMesa = 0;

  try {
    const agora = new Date().toISOString();

    const { data: entregas, error: errT } = await supabase
      .from("tracking_v2")
      .select("id, codigo, fornecedor_id, pedido_codigo, data_prevista")
      .lt("data_prevista", agora)
      .is("data_realizada", null);

    if (errT) throw errT;
    if (!entregas?.length) {
      await log("verificar_tracking_atrasado", "Nenhuma entrega atrasada", "tracking_check", "nenhuma_acao", true, Date.now() - inicio);
      return { acao: "verificar_tracking_atrasado", sucesso: true, resumo: "Nenhuma entrega atrasada.", detalhes: { notificados: 0, alertasMesa: 0 } };
    }

    for (const e of entregas) {
      const diasAtraso = diasDesde(e.data_prevista);

      // Notificar fornecedor sobre atraso
      await criarNotificacao(
        e.fornecedor_id,
        "tracking_atraso",
        "Entrega atrasada",
        `Pedido ${e.pedido_codigo} esta com entrega atrasada em ${Math.floor(diasAtraso)} dia(s). Favor atualizar o status.`,
        "whatsapp",
      );
      notificados++;

      if (diasAtraso > 3) {
        // Atraso critico — alertar mesa
        await notificarMesa(
          "tracking_atraso_critico",
          `ALERTA: Entrega ${e.pedido_codigo} atrasada`,
          `Entrega ${e.pedido_codigo} atrasada ha ${Math.floor(diasAtraso)} dias. Intervencao necessaria.`,
          true,
          "INTERVIR_ENTREGA",
          e.pedido_codigo,
        );
        alertasMesa++;
      }

      await log(
        `verificar_tracking_atrasado: ${e.pedido_codigo}`,
        `Atraso ${Math.floor(diasAtraso)} dias — ${diasAtraso > 3 ? "alerta mesa" : "notificado fornecedor"}`,
        "tracking_check",
        diasAtraso > 3 ? "alerta_mesa_atraso" : "notificar_fornecedor_atraso",
        true,
        Date.now() - inicio,
      );
    }

    const resumo = `Tracking atrasado: ${entregas.length} entregas, ${notificados} notificados, ${alertasMesa} alertas mesa.`;
    await log("verificar_tracking_atrasado", resumo, "tracking_check", "verificacao_completa", true, Date.now() - inicio);

    return { acao: "verificar_tracking_atrasado", sucesso: true, resumo, detalhes: { total: entregas.length, notificados, alertasMesa } };
  } catch (err) {
    const msg = `Erro: ${String(err)}`;
    await log("verificar_tracking_atrasado", msg, "tracking_check", "erro", false, Date.now() - inicio);
    return { acao: "verificar_tracking_atrasado", sucesso: false, resumo: msg, detalhes: {} };
  }
}

// ---------------------------------------------------------------------------
// 5. resumo_operacional
// ---------------------------------------------------------------------------

async function resumoOperacional(): Promise<ActionResult> {
  const inicio = Date.now();

  try {
    // Demandas ativas sem proposta
    const { data: demandasAtivas } = await supabase
      .from("demandas_v2")
      .select("id")
      .eq("status", "ativa");

    let semProposta = 0;
    if (demandasAtivas?.length) {
      const ids = demandasAtivas.map((d: { id: string }) => d.id);
      const { data: propostas } = await supabase
        .from("propostas_v2")
        .select("demanda_id")
        .in("demanda_id", ids);

      const comProposta = new Set(
        (propostas || []).map((p: { demanda_id: string }) => p.demanda_id),
      );
      semProposta = demandasAtivas.filter((d: { id: string }) => !comProposta.has(d.id)).length;
    }

    // Negociacoes paradas (>12h sem mensagem)
    let negParadas = 0;
    const { data: negsAtivas } = await supabase
      .from("negociacoes_v2")
      .select("id")
      .eq("status", "em_andamento");

    if (negsAtivas?.length) {
      for (const neg of negsAtivas) {
        const { data: ultimaMsg } = await supabase
          .from("mensagens_v2")
          .select("criado_em")
          .eq("negociacao_id", neg.id)
          .order("criado_em", { ascending: false })
          .limit(1);

        if (ultimaMsg?.[0]?.criado_em && horasDesde(ultimaMsg[0].criado_em) > 12) {
          negParadas++;
        }
      }
    }

    // Comissoes pendentes
    const agora = new Date().toISOString();
    const { count: comissoesPendentes } = await supabase
      .from("financials_v2")
      .select("*", { count: "exact", head: true })
      .eq("status", "cobrada")
      .lt("vencimento_comissao", agora);

    // Tracking atrasado
    const { count: trackingAtrasado } = await supabase
      .from("tracking_v2")
      .select("*", { count: "exact", head: true })
      .lt("data_prevista", agora)
      .is("data_realizada", null);

    const dataHoje = new Date().toLocaleDateString("pt-BR");
    const dashboard = [
      `RESUMO OPERACIONAL — ${dataHoje}`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      ``,
      `Demandas ativas sem proposta: ${semProposta}`,
      `Negociacoes paradas (>12h):   ${negParadas}`,
      `Comissoes vencidas:           ${comissoesPendentes || 0}`,
      `Entregas atrasadas:           ${trackingAtrasado || 0}`,
      ``,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `Total de itens que requerem atencao: ${semProposta + negParadas + (comissoesPendentes || 0) + (trackingAtrasado || 0)}`,
    ].join("\n");

    // Salvar resumo para mesa
    await notificarMesa(
      "resumo_operacional",
      `Resumo Operacional ${dataHoje}`,
      dashboard,
      false,
    );

    await log("resumo_operacional", dashboard, "resumo", "resumo_gerado", true, Date.now() - inicio);

    return {
      acao: "resumo_operacional",
      sucesso: true,
      resumo: dashboard,
      detalhes: {
        demandas_sem_proposta: semProposta,
        negociacoes_paradas: negParadas,
        comissoes_vencidas: comissoesPendentes || 0,
        tracking_atrasado: trackingAtrasado || 0,
      },
    };
  } catch (err) {
    const msg = `Erro: ${String(err)}`;
    await log("resumo_operacional", msg, "resumo", "erro", false, Date.now() - inicio);
    return { acao: "resumo_operacional", sucesso: false, resumo: msg, detalhes: {} };
  }
}

// ---------------------------------------------------------------------------
// 6. run_all
// ---------------------------------------------------------------------------

async function runAll(): Promise<ActionResult> {
  const inicio = Date.now();

  const resultados: ActionResult[] = [];

  resultados.push(await verificarSlaPropostas());
  resultados.push(await verificarNegociacoesParadas());
  resultados.push(await verificarComissoesVencidas());
  resultados.push(await verificarTrackingAtrasado());
  resultados.push(await resumoOperacional());

  const sucesso = resultados.every((r) => r.sucesso);
  const resumoCombinado = resultados.map((r) => `[${r.acao}] ${r.resumo}`).join("\n\n");

  await log("run_all", resumoCombinado, "run_all", "execucao_completa", sucesso, Date.now() - inicio);

  return {
    acao: "run_all",
    sucesso,
    resumo: resumoCombinado,
    detalhes: { resultados },
  };
}

// ---------------------------------------------------------------------------
// Roteador de acoes
// ---------------------------------------------------------------------------

const ACOES: Record<string, () => Promise<ActionResult>> = {
  verificar_sla_propostas: verificarSlaPropostas,
  verificar_negociacoes_paradas: verificarNegociacoesParadas,
  verificar_comissoes_vencidas: verificarComissoesVencidas,
  verificar_tracking_atrasado: verificarTrackingAtrasado,
  resumo_operacional: resumoOperacional,
  run_all: runAll,
};

// ---------------------------------------------------------------------------
// HTTP Handler
// ---------------------------------------------------------------------------

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return corsResponse();
  }

  const inicio = Date.now();

  try {
    const { acao }: OpsRequest = await req.json();

    if (!acao || !ACOES[acao]) {
      return jsonResponse(
        {
          erro: `Acao invalida. Acoes disponiveis: ${Object.keys(ACOES).join(", ")}`,
        },
        400,
      );
    }

    console.log(`[ops-agent] Executando acao: ${acao}`);

    const resultado = await ACOES[acao]();

    console.log(`[ops-agent] ${acao} concluido em ${Date.now() - inicio}ms — sucesso=${resultado.sucesso}`);

    return jsonResponse(resultado);
  } catch (err) {
    console.error("[ops-agent] Erro:", err);

    await log(
      "handler",
      `Erro no handler: ${String(err)}`,
      "erro",
      "erro_handler",
      false,
      Date.now() - inicio,
    );

    return jsonResponse(
      { erro: "Erro interno do ops-agent", detalhe: String(err) },
      500,
    );
  }
});
