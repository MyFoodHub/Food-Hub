/**
 * FoodHub V3 — Tracking Agent
 * Gerencia o ciclo de vida do rastreamento de pedidos no marketplace B2B.
 *
 * Fases (sequenciais e obrigatorias):
 *   confirmado → embarque_projetado → embarque_realizado → nf_emitida
 *   → fatura_liquidada_cliente → comissao_cobrada → comissao_paga → entregue
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  supabase,
  chamarClaude,
  logIA,
  jsonResponse,
  corsResponse,
  criarAprovacao,
  CORS_HEADERS,
} from "../_shared/config.ts";

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

interface TrackingRequest {
  acao: string;
  pedido_id?: string;
  dados?: Record<string, unknown>;
}

type Fase =
  | "confirmado"
  | "embarque_projetado"
  | "embarque_realizado"
  | "nf_emitida"
  | "fatura_liquidada_cliente"
  | "comissao_cobrada"
  | "comissao_paga"
  | "entregue";

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

const AGENTE = "tracking-agent";

const FASES_ORDENADAS: Fase[] = [
  "confirmado",
  "embarque_projetado",
  "embarque_realizado",
  "nf_emitida",
  "fatura_liquidada_cliente",
  "comissao_cobrada",
  "comissao_paga",
  "entregue",
];

const FASE_LABEL: Record<Fase, string> = {
  confirmado: "Confirmado",
  embarque_projetado: "Embarque projetado",
  embarque_realizado: "Embarque realizado",
  nf_emitida: "NF emitida",
  fatura_liquidada_cliente: "Fatura liquidada",
  comissao_cobrada: "Comissao cobrada",
  comissao_paga: "Comissao paga",
  entregue: "Entregue",
};

/** Fases que exigem notificacao obrigatoria da mesa */
const FASES_NOTIFICAR_MESA: Fase[] = [
  "nf_emitida",
  "fatura_liquidada_cliente",
  "comissao_cobrada",
  "comissao_paga",
];

/** Mapeamento de tipo de documento para fase esperada */
const DOCUMENTO_PARA_FASE: Record<string, Fase> = {
  nota_fiscal: "nf_emitida",
  nf: "nf_emitida",
  boleto: "fatura_liquidada_cliente",
  comprovante_pagamento: "fatura_liquidada_cliente",
  comprovante_embarque: "embarque_realizado",
  conhecimento_transporte: "embarque_realizado",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function proximaFase(faseAtual: Fase): Fase | null {
  const idx = FASES_ORDENADAS.indexOf(faseAtual);
  if (idx < 0 || idx >= FASES_ORDENADAS.length - 1) return null;
  return FASES_ORDENADAS[idx + 1];
}

function faseValida(fase: string): fase is Fase {
  return FASES_ORDENADAS.includes(fase as Fase);
}

async function buscarPedido(pedido_id: string) {
  const { data, error } = await supabase
    .from("pedidos")
    .select("*")
    .eq("id", pedido_id)
    .single();

  if (error || !data) throw new Error(`Pedido ${pedido_id} nao encontrado`);
  return data;
}

async function buscarUltimaFase(pedido_id: string): Promise<Fase | null> {
  const { data } = await supabase
    .from("tracking_v2")
    .select("fase")
    .eq("pedido_id", pedido_id)
    .order("criado_em", { ascending: false })
    .limit(1)
    .single();

  if (!data) return null;
  return data.fase as Fase;
}

async function buscarTrackingCompleto(pedido_id: string) {
  const { data, error } = await supabase
    .from("tracking_v2")
    .select("*")
    .eq("pedido_id", pedido_id)
    .order("criado_em", { ascending: true });

  if (error) throw new Error(`Erro ao buscar tracking: ${error.message}`);
  return data || [];
}

async function criarEntradaTracking(
  pedido_id: string,
  fase: Fase,
  extras: Record<string, unknown> = {}
) {
  const { data, error } = await supabase
    .from("tracking_v2")
    .insert({
      pedido_id,
      fase,
      data_realizada: new Date().toISOString(),
      criado_em: new Date().toISOString(),
      ...extras,
    })
    .select()
    .single();

  if (error) throw new Error(`Erro ao criar tracking: ${error.message}`);
  return data;
}

async function notificarPartes(
  pedido: Record<string, unknown>,
  fase: Fase,
  mensagemExtra?: string
) {
  const now = new Date().toISOString();
  const codigo = (pedido.codigo as string) || `PED-${pedido.id}`;
  const titulo = `Pedido ${codigo} — ${FASE_LABEL[fase]}`;
  const mensagem = mensagemExtra || `O pedido ${codigo} avancou para: ${FASE_LABEL[fase]}.`;

  const notificacoes: Record<string, unknown>[] = [];

  // Notificar comprador
  if (pedido.comprador_id) {
    notificacoes.push({
      member_id: pedido.comprador_id,
      tipo: "tracking_update",
      titulo,
      mensagem,
      canal: "whatsapp",
      acao_requerida: false,
      criado_em: now,
    });
  }

  // Notificar fornecedor
  if (pedido.fornecedor_id) {
    notificacoes.push({
      member_id: pedido.fornecedor_id,
      tipo: "tracking_update",
      titulo,
      mensagem,
      canal: "whatsapp",
      acao_requerida: false,
      criado_em: now,
    });
  }

  // Notificar mesa para fases criticas
  if (FASES_NOTIFICAR_MESA.includes(fase)) {
    const { data: mesa } = await supabase
      .from("members")
      .select("id")
      .eq("tipo", "mesa")
      .eq("status", "ativo");

    if (mesa?.length) {
      for (const m of mesa) {
        notificacoes.push({
          member_id: m.id,
          tipo: "tracking_mesa",
          titulo,
          mensagem,
          canal: "dashboard",
          acao_requerida: fase === "nf_emitida",
          acao_tipo: fase === "nf_emitida" ? "VALIDAR_NF" : undefined,
          acao_codigo: codigo,
          criado_em: now,
        });
      }
    }
  }

  if (notificacoes.length > 0) {
    await supabase.from("notificacoes_v2").insert(notificacoes);
  }
}

// ---------------------------------------------------------------------------
// Acoes
// ---------------------------------------------------------------------------

async function iniciarTracking(pedido_id: string): Promise<Response> {
  const inicio = Date.now();
  const pedido = await buscarPedido(pedido_id);

  // Verificar se tracking ja existe
  const faseAtual = await buscarUltimaFase(pedido_id);
  if (faseAtual) {
    return jsonResponse(
      { erro: `Tracking ja iniciado para pedido ${pedido_id}. Fase atual: ${faseAtual}` },
      400
    );
  }

  const entry = await criarEntradaTracking(pedido_id, "confirmado");

  await notificarPartes(
    pedido,
    "confirmado",
    `Pedido ${pedido.codigo || pedido_id} confirmado! Acompanhe o progresso em tempo real.`
  );

  await logIA(
    AGENTE,
    null,
    "api",
    `iniciar_tracking pedido=${pedido_id}`,
    `Tracking iniciado fase=confirmado`,
    "iniciar_tracking",
    "criar_tracking_v2",
    true,
    Date.now() - inicio
  );

  return jsonResponse({ ok: true, fase: "confirmado", tracking: entry });
}

async function avancarFase(
  pedido_id: string,
  dados?: Record<string, unknown>
): Promise<Response> {
  const inicio = Date.now();
  const pedido = await buscarPedido(pedido_id);
  const faseAtual = await buscarUltimaFase(pedido_id);

  if (!faseAtual) {
    return jsonResponse({ erro: "Tracking nao iniciado. Use iniciar_tracking primeiro." }, 400);
  }

  const proxima = proximaFase(faseAtual);
  if (!proxima) {
    return jsonResponse({ erro: `Pedido ja esta na fase final: ${faseAtual}` }, 400);
  }

  const extras: Record<string, unknown> = {};

  // Se documento_url fornecido, usar Claude para extrair dados
  if (dados?.documento_url) {
    extras.documento_url = dados.documento_url;
    extras.documento_lido_ia = true;

    try {
      const descricaoDoc = await chamarClaude(
        `Voce e um assistente financeiro B2B. Um documento foi enviado com a URL: ${dados.documento_url}
Contexto: pedido ${pedido.codigo || pedido_id}, avancando para fase "${FASE_LABEL[proxima]}".
Extraia os dados relevantes do documento (numero, valor, data, etc).
Retorne APENAS um JSON com os campos encontrados: {"numero_documento": "...", "valor": ..., "data_emissao": "...", "observacoes": "..."}`,
        "Voce e um extrator de dados de documentos fiscais e financeiros do FoodHub B2B."
      );

      try {
        const dadosDoc = JSON.parse(descricaoDoc);
        extras.dados_documento = dadosDoc;
      } catch {
        extras.dados_documento = { texto_raw: descricaoDoc };
      }
    } catch (err) {
      console.error(`[${AGENTE}] Erro ao analisar documento com Claude:`, err);
      extras.dados_documento = { erro: "Falha na analise automatica" };
    }
  }

  if (dados?.data_prevista) {
    extras.data_prevista = dados.data_prevista;
  }
  if (dados?.observacao) {
    extras.observacao = dados.observacao;
  }

  const entry = await criarEntradaTracking(pedido_id, proxima, extras);

  await notificarPartes(pedido, proxima);

  await logIA(
    AGENTE,
    null,
    "api",
    `avancar_fase pedido=${pedido_id} de=${faseAtual} para=${proxima}`,
    `Fase avancada para ${proxima}`,
    "avancar_fase",
    "criar_tracking_v2",
    true,
    Date.now() - inicio
  );

  return jsonResponse({ ok: true, fase_anterior: faseAtual, fase_atual: proxima, tracking: entry });
}

async function processarDocumento(
  pedido_id: string,
  dados?: Record<string, unknown>
): Promise<Response> {
  const inicio = Date.now();
  const documento_url = dados?.documento_url as string | undefined;

  if (!documento_url) {
    return jsonResponse({ erro: "documento_url e obrigatorio para processar_documento" }, 400);
  }

  const pedido = await buscarPedido(pedido_id);
  const faseAtual = await buscarUltimaFase(pedido_id);

  // Usar Claude para analisar tipo e extrair dados do documento
  const analise = await chamarClaude(
    `Voce e um assistente financeiro de uma plataforma B2B de alimentos (FoodHub).
Um fornecedor enviou um documento via WhatsApp para o pedido ${pedido.codigo || pedido_id}.
URL do documento: ${documento_url}

Analise o tipo de documento e extraia os dados relevantes.
Retorne SOMENTE um JSON valido:
{
  "tipo_documento": "nota_fiscal" | "boleto" | "comprovante_pagamento" | "comprovante_embarque" | "conhecimento_transporte" | "outro",
  "numero_nf": "string ou null",
  "valor": numero ou null,
  "data_emissao": "YYYY-MM-DD ou null",
  "data_vencimento": "YYYY-MM-DD ou null",
  "cnpj_emitente": "string ou null",
  "chave_acesso": "string ou null",
  "observacoes": "string ou null"
}`,
    "Voce e um especialista em documentos fiscais brasileiros (NF-e, boleto, CT-e). Sempre retorne JSON valido."
  );

  let dadosExtraidos: Record<string, unknown>;
  try {
    dadosExtraidos = JSON.parse(analise);
  } catch {
    dadosExtraidos = {
      tipo_documento: "outro",
      observacoes: "Falha na analise automatica — revisar manualmente",
      texto_raw: analise,
    };
  }

  const tipoDoc = (dadosExtraidos.tipo_documento as string) || "outro";

  // Salvar na tabela nf_documentos
  const { data: docSalvo, error: errDoc } = await supabase
    .from("nf_documentos")
    .insert({
      pedido_id,
      tipo: tipoDoc,
      url: documento_url,
      numero_nf: dadosExtraidos.numero_nf || null,
      valor: dadosExtraidos.valor || null,
      data_emissao: dadosExtraidos.data_emissao || null,
      data_vencimento: dadosExtraidos.data_vencimento || null,
      cnpj_emitente: dadosExtraidos.cnpj_emitente || null,
      chave_acesso: dadosExtraidos.chave_acesso || null,
      status: "validada_ia",
      documento_lido_ia: true,
      dados_extraidos: dadosExtraidos,
      criado_em: new Date().toISOString(),
    })
    .select()
    .single();

  if (errDoc) {
    throw new Error(`Erro ao salvar documento: ${errDoc.message}`);
  }

  // Auto-avancar fase se documento corresponde a fase esperada
  let faseAvancada: Fase | null = null;
  const faseEsperada = DOCUMENTO_PARA_FASE[tipoDoc];

  if (faseEsperada && faseAtual) {
    const proxima = proximaFase(faseAtual);
    if (proxima === faseEsperada) {
      await criarEntradaTracking(pedido_id, faseEsperada, {
        documento_url,
        documento_lido_ia: true,
        dados_documento: dadosExtraidos,
      });
      await notificarPartes(
        pedido,
        faseEsperada,
        `Documento (${tipoDoc}) processado automaticamente. Pedido ${pedido.codigo || pedido_id} avancou para ${FASE_LABEL[faseEsperada]}.`
      );
      faseAvancada = faseEsperada;
    }
  }

  // Criar aprovacao para NF se necessario
  if (tipoDoc === "nota_fiscal" || tipoDoc === "nf") {
    await criarAprovacao(
      "validacao_nf",
      docSalvo.id,
      `NF-${dadosExtraidos.numero_nf || pedido.codigo || pedido_id}`
    );
  }

  await logIA(
    AGENTE,
    null,
    "whatsapp",
    `processar_documento pedido=${pedido_id} url=${documento_url}`,
    `Documento tipo=${tipoDoc} processado. ${faseAvancada ? `Fase avancada para ${faseAvancada}` : "Sem avanco automatico"}`,
    "processar_documento",
    "analisar_documento_ia",
    true,
    Date.now() - inicio
  );

  return jsonResponse({
    ok: true,
    documento: docSalvo,
    dados_extraidos: dadosExtraidos,
    fase_avancada: faseAvancada,
  });
}

async function consultarTracking(pedido_id: string): Promise<Response> {
  const inicio = Date.now();
  const pedido = await buscarPedido(pedido_id);
  const entradas = await buscarTrackingCompleto(pedido_id);

  const codigo = (pedido.codigo as string) || `PED-${pedido_id}`;
  const produto = (pedido.produto as string) || "";
  const quantidade = pedido.quantidade ? `${pedido.quantidade}${pedido.unidade || "kg"}` : "";
  const descricao = [produto, quantidade].filter(Boolean).join(" ");

  // Montar mapa de fases realizadas
  const fasesRealizadas: Record<string, { data_realizada: string }> = {};
  for (const e of entradas) {
    fasesRealizadas[e.fase] = { data_realizada: e.data_realizada };
  }

  // Encontrar fase atual (ultima realizada)
  let faseAtualIdx = -1;
  for (let i = FASES_ORDENADAS.length - 1; i >= 0; i--) {
    if (fasesRealizadas[FASES_ORDENADAS[i]]) {
      faseAtualIdx = i;
      break;
    }
  }

  // Formatar timeline
  const linhas: string[] = [];
  linhas.push(`Pedido ${codigo}${descricao ? ` — ${descricao}` : ""}`);

  for (let i = 0; i < FASES_ORDENADAS.length; i++) {
    const fase = FASES_ORDENADAS[i];
    const realizada = fasesRealizadas[fase];

    if (realizada) {
      const dataFormatada = formatarData(realizada.data_realizada);
      linhas.push(`✅ ${FASE_LABEL[fase]} — ${dataFormatada}`);
    } else if (i === faseAtualIdx + 1) {
      linhas.push(`🔄 ${FASE_LABEL[fase]} — aguardando`);
    } else {
      linhas.push(`⬜ ${FASE_LABEL[fase]}`);
    }
  }

  const timeline = linhas.join("\n");

  await logIA(
    AGENTE,
    null,
    "api",
    `consultar_tracking pedido=${pedido_id}`,
    timeline,
    "consultar_tracking",
    "buscar_tracking_v2",
    true,
    Date.now() - inicio
  );

  return jsonResponse({
    ok: true,
    pedido_id,
    codigo,
    fase_atual: faseAtualIdx >= 0 ? FASES_ORDENADAS[faseAtualIdx] : null,
    timeline,
    entradas,
  });
}

async function alertarAtrasos(): Promise<Response> {
  const inicio = Date.now();

  // Buscar fases com data_prevista vencida e sem data_realizada
  const { data: atrasados, error } = await supabase
    .from("tracking_v2")
    .select("*, pedidos!inner(id, codigo, comprador_id, fornecedor_id, produto)")
    .lt("data_prevista", new Date().toISOString())
    .is("data_realizada", null);

  if (error) throw new Error(`Erro ao buscar atrasos: ${error.message}`);

  if (!atrasados?.length) {
    await logIA(
      AGENTE,
      null,
      "cron",
      "alertar_atrasos",
      "Nenhum atraso encontrado",
      "alertar_atrasos",
      "verificar_atrasos",
      true,
      Date.now() - inicio
    );
    return jsonResponse({ ok: true, atrasos: 0, mensagem: "Nenhum atraso encontrado" });
  }

  const now = new Date().toISOString();
  const notificacoes: Record<string, unknown>[] = [];

  for (const atraso of atrasados) {
    const pedido = atraso.pedidos;
    const codigo = pedido?.codigo || `PED-${atraso.pedido_id}`;
    const diasAtraso = Math.ceil(
      (Date.now() - new Date(atraso.data_prevista).getTime()) / (1000 * 60 * 60 * 24)
    );
    const mensagem = `Pedido ${codigo} — fase "${FASE_LABEL[atraso.fase as Fase] || atraso.fase}" atrasada em ${diasAtraso} dia(s).`;

    // Notificar fornecedor
    if (pedido?.fornecedor_id) {
      notificacoes.push({
        member_id: pedido.fornecedor_id,
        tipo: "tracking_atraso",
        titulo: `Atraso no pedido ${codigo}`,
        mensagem,
        canal: "whatsapp",
        acao_requerida: true,
        acao_tipo: "ATUALIZAR_TRACKING",
        acao_codigo: codigo,
        criado_em: now,
      });
    }

    // Notificar mesa
    const { data: mesa } = await supabase
      .from("members")
      .select("id")
      .eq("tipo", "mesa")
      .eq("status", "ativo");

    if (mesa?.length) {
      for (const m of mesa) {
        notificacoes.push({
          member_id: m.id,
          tipo: "tracking_atraso_mesa",
          titulo: `Atraso detectado: ${codigo}`,
          mensagem,
          canal: "dashboard",
          acao_requerida: true,
          acao_tipo: "VERIFICAR_ATRASO",
          acao_codigo: codigo,
          criado_em: now,
        });
      }
    }
  }

  if (notificacoes.length > 0) {
    await supabase.from("notificacoes_v2").insert(notificacoes);
  }

  await logIA(
    AGENTE,
    null,
    "cron",
    "alertar_atrasos",
    `${atrasados.length} atraso(s) encontrado(s), ${notificacoes.length} notificacao(oes) enviada(s)`,
    "alertar_atrasos",
    "notificar_atrasos",
    true,
    Date.now() - inicio
  );

  return jsonResponse({
    ok: true,
    atrasos: atrasados.length,
    notificacoes_enviadas: notificacoes.length,
    detalhes: atrasados.map((a) => ({
      pedido_id: a.pedido_id,
      fase: a.fase,
      data_prevista: a.data_prevista,
    })),
  });
}

// ---------------------------------------------------------------------------
// Utilidades de formatacao
// ---------------------------------------------------------------------------

function formatarData(iso: string): string {
  try {
    const d = new Date(iso);
    const dia = String(d.getDate()).padStart(2, "0");
    const mes = String(d.getMonth() + 1).padStart(2, "0");
    return `${dia}/${mes}`;
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// Handler HTTP
// ---------------------------------------------------------------------------

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return corsResponse();
  }

  const inicio = Date.now();

  try {
    const { acao, pedido_id, dados }: TrackingRequest = await req.json();

    if (!acao) {
      return jsonResponse({ erro: "Campo 'acao' e obrigatorio" }, 400);
    }

    console.log(`[${AGENTE}] acao=${acao} pedido_id=${pedido_id || "N/A"}`);

    switch (acao) {
      case "iniciar_tracking": {
        if (!pedido_id) {
          return jsonResponse({ erro: "pedido_id e obrigatorio para iniciar_tracking" }, 400);
        }
        return await iniciarTracking(pedido_id);
      }

      case "avancar_fase": {
        if (!pedido_id) {
          return jsonResponse({ erro: "pedido_id e obrigatorio para avancar_fase" }, 400);
        }
        return await avancarFase(pedido_id, dados);
      }

      case "processar_documento": {
        if (!pedido_id) {
          return jsonResponse({ erro: "pedido_id e obrigatorio para processar_documento" }, 400);
        }
        return await processarDocumento(pedido_id, dados);
      }

      case "consultar_tracking": {
        if (!pedido_id) {
          return jsonResponse({ erro: "pedido_id e obrigatorio para consultar_tracking" }, 400);
        }
        return await consultarTracking(pedido_id);
      }

      case "alertar_atrasos": {
        return await alertarAtrasos();
      }

      default:
        return jsonResponse(
          {
            erro: `Acao desconhecida: ${acao}`,
            acoes_disponiveis: [
              "iniciar_tracking",
              "avancar_fase",
              "processar_documento",
              "consultar_tracking",
              "alertar_atrasos",
            ],
          },
          400
        );
    }
  } catch (err) {
    console.error(`[${AGENTE}] Erro:`, err);

    await logIA(
      AGENTE,
      null,
      "api",
      "erro",
      String(err),
      "erro",
      "erro_interno",
      false,
      Date.now() - inicio
    ).catch(() => {});

    return jsonResponse(
      { erro: "Erro interno do tracking-agent", detalhe: String(err) },
      500
    );
  }
});
