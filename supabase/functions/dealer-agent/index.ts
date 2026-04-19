/**
 * FoodHub V3 — Dealer Agent (WhatsApp AI)
 *
 * Main conversational agent for the B2B food marketplace.
 * Receives text messages via POST, manages multi-turn sessions,
 * classifies products dynamically via Claude + categorias_referencia,
 * and orchestrates the full demand-creation flow.
 *
 * Key design decisions:
 * - No hardcoded product fields: category specs come from DB + Claude classification
 * - Session state persisted in mensagens_v2 (tipo='whatsapp_session')
 * - Max 2 questions per message to keep WhatsApp UX tight
 * - Language detection: respond in the same language the user writes
 * - All actions logged via logIA()
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  supabase,
  chamarClaude,
  gerarCodigo,
  criarAprovacao,
  logIA,
  jsonResponse,
  corsResponse,
  CORS_HEADERS,
} from "../_shared/config.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DealerRequest {
  texto: string;
  usuario_id: string;
}

interface ConversationState {
  fase: "identificacao" | "coletando_specs" | "coletando_basicos" | "confirmacao";
  produto: string | null;
  categoria: string | null;
  quantidade: number | null;
  unidade: string | null;
  local_entrega: string | null;
  step_atual: number;
  specs: Record<string, string>;
  campos_pendentes: string[];
  created_at: string;
}

interface IntentResult {
  intencao: string;
  produto: string | null;
  quantidade: number | null;
  unidade: string | null;
  local_entrega: string | null;
  specs_extraidos: Record<string, string>;
  idioma: string;
  codigo_aprovacao?: string;
}

interface ClassificationResult {
  categoria: string;
  tags: string[];
  campos: CampoProduto[];
}

interface CampoProduto {
  campo: string;
  label: string;
  tipo: "opcoes" | "aberta";
  opcoes: string[];
  aceita_outro: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AGENTE = "dealer-agent";
const CANAL = "whatsapp";
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

/** Universal fields appended after product-specific specs. */
const CAMPOS_UNIVERSAIS: CampoProduto[] = [
  {
    campo: "frete",
    label: "Tipo de frete",
    tipo: "opcoes",
    opcoes: ["CIF (entrega na porta)", "FOB (retira na fábrica)", "Flexível"],
    aceita_outro: false,
  },
  {
    campo: "prazo_expedicao",
    label: "Prazo de expedição",
    tipo: "opcoes",
    opcoes: ["3 dias úteis", "5 dias úteis", "7 dias úteis", "10 dias úteis"],
    aceita_outro: true,
  },
  {
    campo: "prazo_entrega_cif",
    label: "Prazo de entrega na porta",
    tipo: "aberta",
    opcoes: [],
    aceita_outro: true,
  },
  {
    campo: "prazo_pagamento",
    label: "Condição de pagamento",
    tipo: "aberta",
    opcoes: [],
    aceita_outro: true,
  },
  {
    campo: "certificacao",
    label: "Exigência de certificação",
    tipo: "opcoes",
    opcoes: ["GFSI", "FSSC 22000", "SIF", "sem exigência"],
    aceita_outro: true,
  },
];

const NOTAS_FRETE: Record<string, string> = {
  FOB: "Certo. No FOB, o prazo de chegada após retirada na fábrica fica por sua responsabilidade.",
  CIF: "Certo. A indústria será responsável pela entrega completa até você.",
};

// ---------------------------------------------------------------------------
// Session persistence (mensagens_v2)
// ---------------------------------------------------------------------------

async function carregarSessao(usuario_id: string): Promise<ConversationState | null> {
  const { data } = await supabase
    .from("mensagens_v2")
    .select("conteudo")
    .eq("remetente_id", usuario_id)
    .eq("tipo", "whatsapp_session")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (!data?.conteudo) return null;
  try {
    const state: ConversationState = JSON.parse(data.conteudo);
    if (Date.now() - new Date(state.created_at).getTime() > SESSION_TTL_MS) return null;
    return state;
  } catch {
    return null;
  }
}

async function salvarSessao(usuario_id: string, state: ConversationState): Promise<void> {
  // Delete previous session rows, then insert fresh
  await supabase
    .from("mensagens_v2")
    .delete()
    .eq("remetente_id", usuario_id)
    .eq("tipo", "whatsapp_session");

  await supabase.from("mensagens_v2").insert({
    remetente_id: usuario_id,
    tipo: "whatsapp_session",
    conteudo: JSON.stringify({ ...state, created_at: new Date().toISOString() }),
    created_at: new Date().toISOString(),
  });
}

async function limparSessao(usuario_id: string): Promise<void> {
  await supabase
    .from("mensagens_v2")
    .delete()
    .eq("remetente_id", usuario_id)
    .eq("tipo", "whatsapp_session");
}

function novaConversacao(): ConversationState {
  return {
    fase: "identificacao",
    produto: null,
    categoria: null,
    quantidade: null,
    unidade: null,
    local_entrega: null,
    step_atual: 0,
    specs: {},
    campos_pendentes: [],
    created_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Claude-based intent detection
// ---------------------------------------------------------------------------

async function identificarIntencaoEDados(texto: string, perfil?: string): Promise<IntentResult> {
  const perfilContext = perfil
    ? `\nO usuário tem perfil "${perfil}" no sistema. Considere isso ao classificar a intenção.
- comprador: foco em compras, demandas, propostas recebidas
- fornecedor: foco em oportunidades, propostas enviadas, pedidos, NF
- seller: foco em clientes, pipeline, comissões
- originador: foco em fornecedores trazidos, deals, comissões
- mesa: foco em aprovações, pipeline geral, financeiro`
    : "";

  const system = `Você é o agente de IA do FoodHub, plataforma B2B de alimentos.
Analise a mensagem do usuário e retorne SOMENTE um JSON válido, sem markdown.
${perfilContext}

Formato:
{
  "intencao": "criar_demanda" | "consultar_status" | "pedir_resumo" | "aprovar" | "desconhecida",
  "produto": "nome específico do produto ou null",
  "quantidade": number | null,
  "unidade": "kg" | "ton" | "un" | "cx" | null,
  "local_entrega": "cidade/estado ou null",
  "specs_extraidos": { campo: valor } para qualquer especificação já mencionada (corte, conservação, embalagem, etc),
  "idioma": "pt" | "en" | "es",
  "codigo_aprovacao": "código se intenção=aprovar, ex: DEM-0001"
}

Regras:
- "criar_demanda": usuário quer comprar/precisa de algum produto alimentício
- "consultar_status": pergunta sobre pedidos/demandas existentes
- "pedir_resumo": quer resumo geral ou diz "foodhub me atualiza"
- "aprovar": mesa aprovando via "APROVAR [código]"
- "desconhecida": não se encaixa em nenhuma
- Extraia TUDO que o usuário já informou de uma vez. Se ele disse "preciso de 10 ton de frango sassami congelado IQF em SP", extraia produto, quantidade, unidade, local E specs (conservacao=congelado, corte=IQF).
- Detecte o idioma da mensagem.`;

  const resposta = await chamarClaude(texto, system);
  try {
    return JSON.parse(resposta);
  } catch {
    return {
      intencao: "desconhecida",
      produto: null,
      quantidade: null,
      unidade: null,
      local_entrega: null,
      specs_extraidos: {},
      idioma: "pt",
    };
  }
}

// ---------------------------------------------------------------------------
// Dynamic product classification via Claude + categorias_referencia
// ---------------------------------------------------------------------------

async function classificarProduto(produto: string): Promise<ClassificationResult> {
  // Fetch category reference from DB
  const { data: categorias } = await supabase
    .from("categorias_referencia")
    .select("*");

  const catContext = categorias?.length
    ? `Categorias cadastradas no sistema:\n${categorias.map(
        (c: Record<string, unknown>) =>
          `- ${c.nome}: ${c.descricao || ""} | campos: ${JSON.stringify(c.campos_especificos || [])}`
      ).join("\n")}`
    : "Nenhuma categoria pré-cadastrada. Classifique livremente.";

  const system = `Você é um classificador de produtos alimentícios B2B.
${catContext}

Dado o produto informado, retorne SOMENTE um JSON válido:
{
  "categoria": "slug da categoria (ex: frango_sassami, carne_bovina, arroz)",
  "tags": ["tag1", "tag2"],
  "campos": [
    {
      "campo": "nome_tecnico_do_campo",
      "label": "Rótulo legível para o usuário",
      "tipo": "opcoes" | "aberta",
      "opcoes": ["op1", "op2"] (vazio se tipo=aberta),
      "aceita_outro": true | false
    }
  ]
}

Regras para campos:
- Inclua apenas especificações TÉCNICAS relevantes para o produto (corte, conservação, embalagem, tipo, etc).
- NÃO inclua frete, prazo, pagamento ou certificação — esses são universais e já tratados separadamente.
- Ordem lógica: mais importante primeiro.
- Se uma categoria cadastrada corresponder, use seus campos. Senão, infira os campos mais relevantes.`;

  const resposta = await chamarClaude(`Produto: "${produto}"`, system);
  try {
    return JSON.parse(resposta);
  } catch {
    return {
      categoria: "outro",
      tags: [],
      campos: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Claude-based answer validation
// ---------------------------------------------------------------------------

async function validarResposta(
  texto: string,
  campo: CampoProduto
): Promise<string | null> {
  if (campo.tipo === "aberta") {
    const system = `O usuário respondeu para a pergunta "${campo.label}".
Se a resposta faz sentido no contexto de compra B2B de alimentos, retorne {"valor": "resposta_limpa"}.
Se não faz sentido, retorne {"valor": null}.
Retorne APENAS o JSON.`;

    const resposta = await chamarClaude(`Resposta: "${texto}"`, system);
    try {
      return JSON.parse(resposta).valor || null;
    } catch {
      return texto.trim() || null;
    }
  }

  const system = `O usuário respondeu para: "${campo.label}"
Opções válidas: ${campo.opcoes.join(", ")}${campo.aceita_outro ? " (aceita valores fora da lista)" : ""}

Retorne SOMENTE JSON: {"valor": "opcao_escolhida"} ou {"valor": null} se inválido.
Se o usuário usou número (1, 2, 3...), mapeie para a opção na posição.
Se usou sinônimo/abreviação, mapeie para a opção correspondente.
${campo.aceita_outro ? 'Se o valor não está na lista mas faz sentido, retorne {"valor": "valor_informado"}.' : ""}`;

  const resposta = await chamarClaude(`Resposta: "${texto}"`, system);
  try {
    return JSON.parse(resposta).valor || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Build pending fields list
// ---------------------------------------------------------------------------

function construirCamposPendentes(
  campos: CampoProduto[],
  specsJaColetados: Record<string, string>,
  freteEscolhido?: string
): string[] {
  const todos = [...campos, ...CAMPOS_UNIVERSAIS];
  const pendentes: string[] = [];

  for (const c of todos) {
    if (specsJaColetados[c.campo]) continue;

    // Skip CIF-specific deadline if freight is FOB
    if (c.campo === "prazo_entrega_cif") {
      if (!freteEscolhido) {
        // Will be evaluated later after freight is chosen
        continue;
      }
      if (!freteEscolhido.toUpperCase().includes("CIF") && !freteEscolhido.toUpperCase().includes("FLEX")) {
        continue;
      }
    }

    pendentes.push(c.campo);
  }

  return pendentes;
}

function encontrarCampo(
  campoNome: string,
  camposProduto: CampoProduto[]
): CampoProduto | undefined {
  const todos = [...camposProduto, ...CAMPOS_UNIVERSAIS];
  return todos.find((c) => c.campo === campoNome);
}

// ---------------------------------------------------------------------------
// Format question (max 2 per message)
// ---------------------------------------------------------------------------

function formatarPerguntas(
  camposPendentes: string[],
  camposProduto: CampoProduto[],
  stepAtual: number,
  totalSteps: number
): string {
  const max = Math.min(2, camposPendentes.length);
  let msg = "";

  for (let i = 0; i < max; i++) {
    const nomeCampo = camposPendentes[i];
    const campo = encontrarCampo(nomeCampo, camposProduto);
    if (!campo) continue;

    const stepNum = stepAtual + i + 1;
    msg += `(${stepNum}/${totalSteps}) ${campo.label}?\n`;

    if (campo.tipo === "opcoes" && campo.opcoes.length > 0) {
      msg += "\n";
      campo.opcoes.forEach((op, idx) => {
        msg += `${idx + 1}. ${op}\n`;
      });
      if (campo.aceita_outro) {
        msg += "\nOu digite outro valor.\n";
      }
    }

    if (i < max - 1) msg += "\n";
  }

  return msg;
}

// ---------------------------------------------------------------------------
// Confirmation summary
// ---------------------------------------------------------------------------

function formatarConfirmacao(
  state: ConversationState,
  camposProduto: CampoProduto[]
): string {
  let msg = "Confirma sua demanda?\n\n";
  msg += `*Produto:* ${state.produto || state.categoria}\n`;
  msg += `*Quantidade:* ${state.quantidade} ${state.unidade || "kg"}\n`;
  msg += `*Entrega:* ${state.local_entrega}\n`;

  if (Object.keys(state.specs).length > 0) {
    msg += "\n*Especificações:*\n";
    const todos = [...camposProduto, ...CAMPOS_UNIVERSAIS];
    for (const c of todos) {
      const valor = state.specs[c.campo];
      if (valor) {
        msg += `• ${c.label}: ${valor}\n`;
      }
    }
  }

  msg += "\nResponda *SIM* para confirmar ou *NÃO* para cancelar.";
  return msg;
}

// ---------------------------------------------------------------------------
// Actions: status, dashboard, approve
// ---------------------------------------------------------------------------

async function consultarStatus(usuario_id: string): Promise<string> {
  const { data: demandas } = await supabase
    .from("demandas_v2")
    .select("id, codigo, produto, quantidade, unidade, status, created_at")
    .eq("usuario_id", usuario_id)
    .order("created_at", { ascending: false })
    .limit(5);

  if (!demandas?.length) {
    return "Você ainda não tem demandas registradas. Me diz o que precisa comprar e eu crio pra você!";
  }

  const { data: propostas } = await supabase
    .from("propostas")
    .select("demanda_id, valor, status")
    .in("demanda_id", demandas.map((d: { id: string }) => d.id));

  let resumo = "Suas últimas demandas:\n\n";
  for (const d of demandas) {
    const props = propostas?.filter((p: { demanda_id: string }) => p.demanda_id === d.id) || [];
    resumo += `• *${d.codigo}* — ${d.produto} — ${d.quantidade} ${d.unidade} — _${d.status}_`;
    if (props.length > 0) resumo += ` (${props.length} proposta(s))`;
    resumo += "\n";
  }
  return resumo;
}

async function gerarDashboard(usuario_id: string): Promise<string> {
  const [resDem, resProp, resForn, resAprov] = await Promise.all([
    supabase.from("demandas_v2").select("*", { count: "exact", head: true }).eq("usuario_id", usuario_id),
    supabase.from("propostas").select("*", { count: "exact", head: true }),
    supabase.from("fornecedores").select("*", { count: "exact", head: true }),
    supabase.from("aprovacoes").select("*", { count: "exact", head: true }).eq("status", "pendente"),
  ]);

  // Active demands
  const { count: demAtivas } = await supabase
    .from("demandas_v2")
    .select("*", { count: "exact", head: true })
    .eq("usuario_id", usuario_id)
    .in("status", ["aguardando_aprovacao", "aberta", "em_negociacao"]);

  let msg = "*Dashboard FoodHub*\n\n";
  msg += `Suas demandas: ${resDem.count || 0} (${demAtivas || 0} ativas)\n`;
  msg += `Propostas no mercado: ${resProp.count || 0}\n`;
  msg += `Fornecedores cadastrados: ${resForn.count || 0}\n`;
  msg += `Aprovações pendentes: ${resAprov.count || 0}\n`;
  msg += "\nQuer criar uma nova demanda ou consultar algo específico?";
  return msg;
}

async function processarAprovacao(codigo: string, usuario_id: string): Promise<string> {
  const { data: aprovacao } = await supabase
    .from("aprovacoes")
    .select("*")
    .eq("entidade_codigo", codigo.toUpperCase())
    .eq("status", "pendente")
    .single();

  if (!aprovacao) {
    return `Não encontrei aprovação pendente para o código *${codigo.toUpperCase()}*. Verifique e tente novamente.`;
  }

  const { error } = await supabase
    .from("aprovacoes")
    .update({
      status: "aprovado",
      aprovado_por: usuario_id,
      aprovado_em: new Date().toISOString(),
    })
    .eq("id", aprovacao.id);

  if (error) {
    return "Erro ao processar aprovação. Tente novamente em instantes.";
  }

  // Update entity status
  if (aprovacao.tipo === "demanda") {
    await supabase
      .from("demandas_v2")
      .update({ status: "aberta" })
      .eq("id", aprovacao.entidade_id);
  }

  return `*${codigo.toUpperCase()}* aprovado com sucesso! A demanda está agora aberta para receber propostas.`;
}

// ---------------------------------------------------------------------------
// Save demand to demandas_v2
// ---------------------------------------------------------------------------

async function salvarDemanda(
  state: ConversationState,
  usuario_id: string
): Promise<{ sucesso: boolean; codigo: string; erro?: string }> {
  const codigo = await gerarCodigo("DEM", "demandas_v2");

  const { data, error } = await supabase
    .from("demandas_v2")
    .insert({
      codigo,
      usuario_id,
      produto: state.produto || state.categoria,
      categoria: state.categoria,
      quantidade: state.quantidade,
      unidade: state.unidade || "kg",
      local_entrega: state.local_entrega,
      frete: state.specs.frete || null,
      prazo_expedicao: state.specs.prazo_expedicao || null,
      prazo_entrega: state.specs.prazo_entrega_cif || null,
      prazo_pagamento: state.specs.prazo_pagamento || null,
      certificacao: state.specs.certificacao || null,
      specs: state.specs,
      status: "aguardando_aprovacao",
      created_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (error || !data) {
    console.error(`[${AGENTE}] Erro ao criar demanda:`, error);
    return { sucesso: false, codigo, erro: error?.message };
  }

  // Create approval entry
  await criarAprovacao("demanda", data.id, codigo);

  return { sucesso: true, codigo };
}

// ---------------------------------------------------------------------------
// Profile-specific command handlers
// ---------------------------------------------------------------------------

type UserProfile = "comprador" | "fornecedor" | "seller" | "originador" | "mesa";

interface MemberInfo {
  id: string;
  tipo: UserProfile;
  nome: string;
}

// ---- Comprador commands ----

async function comandoCompradorMinhasDemandas(usuario_id: string): Promise<string> {
  const { data: demandas } = await supabase
    .from("demandas_v2")
    .select("codigo, produto, quantidade, unidade, status, created_at")
    .eq("usuario_id", usuario_id)
    .order("created_at", { ascending: false })
    .limit(10);

  if (!demandas?.length) {
    return "Você ainda não tem demandas registradas. Diga *nova demanda* para criar uma!";
  }

  let msg = "*Suas demandas:*\n\n";
  for (const d of demandas) {
    const statusLabel = d.status.replace(/_/g, " ");
    msg += `• *${d.codigo}* — ${d.produto} — ${d.quantidade} ${d.unidade} — _${statusLabel}_\n`;
  }
  return msg;
}

async function comandoCompradorAceitar(codigo: string, usuario_id: string): Promise<string> {
  const { data: proposta } = await supabase
    .from("propostas")
    .select("id, demanda_id, valor, status")
    .eq("codigo", codigo.toUpperCase())
    .single();

  if (!proposta) {
    return `Não encontrei proposta com código *${codigo.toUpperCase()}*. Verifique e tente novamente.`;
  }

  // Verify the demand belongs to this buyer
  const { data: demanda } = await supabase
    .from("demandas_v2")
    .select("id, usuario_id")
    .eq("id", proposta.demanda_id)
    .single();

  if (!demanda || demanda.usuario_id !== usuario_id) {
    return "Essa proposta não pertence a nenhuma das suas demandas.";
  }

  if (proposta.status !== "pendente" && proposta.status !== "enviada") {
    return `Essa proposta já está com status _${proposta.status}_. Não é possível aceitar.`;
  }

  const { error } = await supabase
    .from("propostas")
    .update({ status: "aceita", atualizado_em: new Date().toISOString() })
    .eq("id", proposta.id);

  if (error) {
    return "Erro ao aceitar proposta. Tente novamente em instantes.";
  }

  return `Proposta *${codigo.toUpperCase()}* aceita com sucesso! O fornecedor será notificado.`;
}

async function comandoCompradorMeAtualiza(usuario_id: string): Promise<string> {
  const [resProp, resDem] = await Promise.all([
    supabase
      .from("propostas")
      .select("id, codigo, demanda_id, valor, status")
      .in("status", ["pendente", "enviada"])
      .limit(10),
    supabase
      .from("demandas_v2")
      .select("id, codigo, produto, status")
      .eq("usuario_id", usuario_id)
      .in("status", ["aberta", "em_negociacao"])
      .limit(10),
  ]);

  let msg = "*Atualização — Comprador*\n\n";

  const demandas = resDem.data || [];
  if (demandas.length > 0) {
    // Filter proposals that belong to this buyer's demands
    const demandaIds = demandas.map((d: { id: string }) => d.id);
    const propostasDoComprador = (resProp.data || []).filter(
      (p: { demanda_id: string }) => demandaIds.includes(p.demanda_id)
    );

    msg += `*${demandas.length}* demanda(s) ativa(s):\n`;
    for (const d of demandas) {
      const props = propostasDoComprador.filter(
        (p: { demanda_id: string }) => p.demanda_id === d.id
      );
      msg += `• *${d.codigo}* — ${d.produto} — _${d.status.replace(/_/g, " ")}_`;
      if (props.length > 0) msg += ` — ${props.length} proposta(s) pendente(s)`;
      msg += "\n";
    }
  } else {
    msg += "Nenhuma demanda ativa no momento.\n";
  }

  msg += "\nDiga *nova demanda* para criar ou *minhas demandas* para ver o histórico.";
  return msg;
}

// ---- Fornecedor commands ----

async function comandoFornecedorOportunidades(usuario_id: string): Promise<string> {
  const { data: demandas } = await supabase
    .from("demandas_v2")
    .select("codigo, produto, quantidade, unidade, local_entrega, status, created_at")
    .in("status", ["aberta"])
    .order("created_at", { ascending: false })
    .limit(10);

  if (!demandas?.length) {
    return "Não há demandas abertas no momento. Fique ligado — te aviso quando surgir algo!";
  }

  let msg = "*Demandas abertas (oportunidades):*\n\n";
  for (const d of demandas) {
    msg += `• *${d.codigo}* — ${d.produto} — ${d.quantidade} ${d.unidade}`;
    if (d.local_entrega) msg += ` — entrega: ${d.local_entrega}`;
    msg += "\n";
  }
  msg += "\nEnvie uma proposta pelo código da demanda!";
  return msg;
}

async function comandoFornecedorMeAtualiza(usuario_id: string): Promise<string> {
  const [resProp, resNeg] = await Promise.all([
    supabase
      .from("propostas")
      .select("id, codigo, demanda_id, valor, status, created_at")
      .eq("fornecedor_id", usuario_id)
      .order("created_at", { ascending: false })
      .limit(10),
    supabase
      .from("demandas_v2")
      .select("id, codigo, produto, status")
      .in("status", ["em_negociacao"])
      .limit(10),
  ]);

  let msg = "*Atualização — Fornecedor*\n\n";

  const propostas = resProp.data || [];
  if (propostas.length > 0) {
    msg += `*Propostas enviadas:*\n`;
    for (const p of propostas) {
      msg += `• *${p.codigo || p.id.substring(0, 8)}* — R$ ${p.valor} — _${p.status}_\n`;
    }
  } else {
    msg += "Nenhuma proposta enviada ainda.\n";
  }

  msg += "\nDiga *demandas* para ver oportunidades abertas.";
  return msg;
}

async function comandoFornecedorPedidos(usuario_id: string): Promise<string> {
  const { data: pedidos } = await supabase
    .from("pedidos_v2")
    .select("id, codigo, status, valor_total, created_at")
    .eq("fornecedor_id", usuario_id)
    .order("created_at", { ascending: false })
    .limit(10);

  if (!pedidos?.length) {
    return "Você não tem pedidos ativos no momento.";
  }

  let msg = "*Seus pedidos ativos:*\n\n";
  for (const p of pedidos) {
    msg += `• *${p.codigo || p.id.substring(0, 8)}* — R$ ${p.valor_total || "—"} — _${p.status}_\n`;
  }
  return msg;
}

async function comandoFornecedorNF(codigo: string, usuario_id: string): Promise<string> {
  const { data: pedido } = await supabase
    .from("pedidos_v2")
    .select("id, codigo, fornecedor_id, status")
    .eq("codigo", codigo.toUpperCase())
    .single();

  if (!pedido) {
    return `Não encontrei pedido com código *${codigo.toUpperCase()}*.`;
  }

  if (pedido.fornecedor_id !== usuario_id) {
    return "Esse pedido não pertence a você.";
  }

  const { error } = await supabase
    .from("tracking_v2")
    .upsert({
      pedido_id: pedido.id,
      etapa: "nf_emitida",
      status: "concluido",
      atualizado_por: usuario_id,
      atualizado_em: new Date().toISOString(),
    });

  if (error) {
    return "Erro ao registrar NF. Tente novamente.";
  }

  return `NF registrada para o pedido *${codigo.toUpperCase()}*! Tracking atualizado.`;
}

// ---- Seller commands ----

async function comandoSellerMeAtualiza(usuario_id: string): Promise<string> {
  // Get clients linked to this seller
  const { data: clientes } = await supabase
    .from("members")
    .select("id, nome")
    .eq("seller_id", usuario_id);

  if (!clientes?.length) {
    return "*Atualização — Seller*\n\nVocê ainda não tem clientes vinculados.";
  }

  const clienteIds = clientes.map((c: { id: string }) => c.id);

  const { data: demandas } = await supabase
    .from("demandas_v2")
    .select("codigo, produto, quantidade, unidade, status, usuario_id")
    .in("usuario_id", clienteIds)
    .in("status", ["aguardando_aprovacao", "aberta", "em_negociacao"])
    .order("created_at", { ascending: false })
    .limit(15);

  let msg = "*Atualização — Seller*\n\n";
  msg += `*${clientes.length}* cliente(s) vinculado(s)\n\n`;

  if (demandas?.length) {
    msg += "*Pipeline de demandas:*\n";
    for (const d of demandas) {
      const cliente = clientes.find((c: { id: string }) => c.id === d.usuario_id);
      msg += `• *${d.codigo}* — ${d.produto} — ${d.quantidade} ${d.unidade} — _${d.status.replace(/_/g, " ")}_ — cliente: ${cliente?.nome || "—"}\n`;
    }
  } else {
    msg += "Nenhuma demanda ativa nos seus clientes.\n";
  }

  return msg;
}

async function comandoSellerComissoes(usuario_id: string): Promise<string> {
  const { data: comissoes } = await supabase
    .from("financials_v2")
    .select("id, tipo, valor, status, referencia_codigo, created_at")
    .eq("beneficiario_id", usuario_id)
    .eq("tipo", "comissao_seller")
    .order("created_at", { ascending: false })
    .limit(10);

  if (!comissoes?.length) {
    return "*Comissões — Seller*\n\nNenhuma comissão registrada ainda.";
  }

  let projetado = 0;
  let realizado = 0;
  for (const c of comissoes) {
    if (c.status === "pago" || c.status === "realizado") {
      realizado += c.valor || 0;
    } else {
      projetado += c.valor || 0;
    }
  }

  let msg = "*Comissões — Seller*\n\n";
  msg += `Projetado: R$ ${projetado.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}\n`;
  msg += `Realizado: R$ ${realizado.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}\n\n`;

  msg += "*Últimas:*\n";
  for (const c of comissoes.slice(0, 5)) {
    msg += `• ${c.referencia_codigo || "—"} — R$ ${c.valor} — _${c.status}_\n`;
  }
  return msg;
}

async function comandoSellerClientes(usuario_id: string): Promise<string> {
  const { data: clientes } = await supabase
    .from("members")
    .select("id, nome, tipo, created_at")
    .eq("seller_id", usuario_id)
    .order("created_at", { ascending: false });

  if (!clientes?.length) {
    return "Você ainda não tem clientes vinculados.";
  }

  let msg = `*Seus clientes (${clientes.length}):*\n\n`;
  for (const c of clientes) {
    msg += `• ${c.nome} — _${c.tipo || "comprador"}_\n`;
  }
  return msg;
}

// ---- Originador commands ----

async function comandoOriginadorMeAtualiza(usuario_id: string): Promise<string> {
  const { data: fornecedores } = await supabase
    .from("members")
    .select("id, nome")
    .eq("originador_id", usuario_id);

  if (!fornecedores?.length) {
    return "*Atualização — Originador*\n\nVocê ainda não tem fornecedores vinculados.";
  }

  const fornecedorIds = fornecedores.map((f: { id: string }) => f.id);

  const { data: propostas } = await supabase
    .from("propostas")
    .select("id, codigo, demanda_id, valor, status, fornecedor_id")
    .in("fornecedor_id", fornecedorIds)
    .order("created_at", { ascending: false })
    .limit(15);

  let msg = "*Atualização — Originador*\n\n";
  msg += `*${fornecedores.length}* fornecedor(es) trazido(s)\n\n`;

  if (propostas?.length) {
    msg += "*Deals dos seus fornecedores:*\n";
    for (const p of propostas) {
      const forn = fornecedores.find((f: { id: string }) => f.id === p.fornecedor_id);
      msg += `• *${p.codigo || p.id.substring(0, 8)}* — R$ ${p.valor} — _${p.status}_ — forn: ${forn?.nome || "—"}\n`;
    }
  } else {
    msg += "Nenhum deal ativo dos seus fornecedores.\n";
  }

  return msg;
}

async function comandoOriginadorComissoes(usuario_id: string): Promise<string> {
  const { data: comissoes } = await supabase
    .from("financials_v2")
    .select("id, tipo, valor, status, referencia_codigo, created_at")
    .eq("beneficiario_id", usuario_id)
    .eq("tipo", "comissao_originador")
    .order("created_at", { ascending: false })
    .limit(10);

  if (!comissoes?.length) {
    return "*Comissões — Originador*\n\nNenhuma comissão registrada ainda.";
  }

  let projetado = 0;
  let realizado = 0;
  for (const c of comissoes) {
    if (c.status === "pago" || c.status === "realizado") {
      realizado += c.valor || 0;
    } else {
      projetado += c.valor || 0;
    }
  }

  let msg = "*Comissões — Originador*\n\n";
  msg += `Projetado: R$ ${projetado.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}\n`;
  msg += `Realizado: R$ ${realizado.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}\n\n`;

  msg += "*Últimas:*\n";
  for (const c of comissoes.slice(0, 5)) {
    msg += `• ${c.referencia_codigo || "—"} — R$ ${c.valor} — _${c.status}_\n`;
  }
  return msg;
}

async function comandoOriginadorFornecedores(usuario_id: string): Promise<string> {
  const { data: fornecedores } = await supabase
    .from("members")
    .select("id, nome, tipo, created_at")
    .eq("originador_id", usuario_id)
    .order("created_at", { ascending: false });

  if (!fornecedores?.length) {
    return "Você ainda não tem fornecedores vinculados.";
  }

  let msg = `*Seus fornecedores (${fornecedores.length}):*\n\n`;
  for (const f of fornecedores) {
    msg += `• ${f.nome}\n`;
  }
  return msg;
}

// ---- Mesa commands ----

async function comandoMesaPipeline(): Promise<string> {
  const { data: demandas } = await supabase
    .from("demandas_v2")
    .select("id, status, quantidade, unidade, specs")
    .in("status", ["aguardando_aprovacao", "aberta", "em_negociacao", "fechada"]);

  if (!demandas?.length) {
    return "*Pipeline — Mesa*\n\nNenhuma demanda no sistema.";
  }

  const byStatus: Record<string, { count: number; valorTotal: number }> = {};
  for (const d of demandas) {
    if (!byStatus[d.status]) byStatus[d.status] = { count: 0, valorTotal: 0 };
    byStatus[d.status].count++;
  }

  let msg = "*Pipeline — Mesa (resumo executivo)*\n\n";
  for (const [status, info] of Object.entries(byStatus)) {
    msg += `• _${status.replace(/_/g, " ")}_: ${info.count} demanda(s)\n`;
  }
  msg += `\n*Total:* ${demandas.length} demanda(s) no sistema`;
  return msg;
}

async function comandoMesaAprovacoes(): Promise<string> {
  const { data: aprovacoes } = await supabase
    .from("aprovacoes")
    .select("id, tipo, entidade_codigo, status, created_at")
    .eq("status", "pendente")
    .order("created_at", { ascending: false })
    .limit(20);

  if (!aprovacoes?.length) {
    return "*Aprovações — Mesa*\n\nNenhuma aprovação pendente. Tudo em dia!";
  }

  let msg = `*Aprovações pendentes (${aprovacoes.length}):*\n\n`;
  for (const a of aprovacoes) {
    msg += `• *${a.entidade_codigo}* — ${a.tipo} — desde ${new Date(a.created_at).toLocaleDateString("pt-BR")}\n`;
  }
  msg += "\nUse *APROVAR [código]* ou *REJEITAR [código] [motivo]* para decidir.";
  return msg;
}

async function comandoMesaRejeitar(codigo: string, motivo: string, usuario_id: string): Promise<string> {
  const { data: aprovacao } = await supabase
    .from("aprovacoes")
    .select("*")
    .eq("entidade_codigo", codigo.toUpperCase())
    .eq("status", "pendente")
    .single();

  if (!aprovacao) {
    return `Não encontrei aprovação pendente para o código *${codigo.toUpperCase()}*.`;
  }

  const { error } = await supabase
    .from("aprovacoes")
    .update({
      status: "rejeitado",
      aprovado_por: usuario_id,
      aprovado_em: new Date().toISOString(),
      motivo_rejeicao: motivo || "Sem motivo informado",
    })
    .eq("id", aprovacao.id);

  if (error) {
    return "Erro ao processar rejeição. Tente novamente.";
  }

  if (aprovacao.tipo === "demanda") {
    await supabase
      .from("demandas_v2")
      .update({ status: "rejeitada" })
      .eq("id", aprovacao.entidade_id);
  }

  return `*${codigo.toUpperCase()}* rejeitado. Motivo: _${motivo || "Sem motivo informado"}_`;
}

async function comandoMesaFinanceiro(): Promise<string> {
  const hoje = new Date().toISOString().split("T")[0];

  const { data: comissoes } = await supabase
    .from("financials_v2")
    .select("id, tipo, valor, status, beneficiario_id")
    .gte("created_at", hoje + "T00:00:00")
    .lte("created_at", hoje + "T23:59:59");

  if (!comissoes?.length) {
    return `*Financeiro — ${hoje}*\n\nNenhuma movimentação de comissões hoje.`;
  }

  let total = 0;
  for (const c of comissoes) {
    total += c.valor || 0;
  }

  let msg = `*Financeiro — ${hoje}*\n\n`;
  msg += `Movimentações: ${comissoes.length}\n`;
  msg += `Total: R$ ${total.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}\n\n`;

  const byTipo: Record<string, number> = {};
  for (const c of comissoes) {
    byTipo[c.tipo] = (byTipo[c.tipo] || 0) + (c.valor || 0);
  }
  for (const [tipo, valor] of Object.entries(byTipo)) {
    msg += `• ${tipo}: R$ ${valor.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}\n`;
  }
  return msg;
}

async function comandoMesaMeAtualiza(usuario_id: string): Promise<string> {
  const [pipeline, aprovacoes, financeiro] = await Promise.all([
    comandoMesaPipeline(),
    comandoMesaAprovacoes(),
    comandoMesaFinanceiro(),
  ]);

  return `${pipeline}\n\n---\n\n${aprovacoes}\n\n---\n\n${financeiro}`;
}

// ---------------------------------------------------------------------------
// Profile command router
// ---------------------------------------------------------------------------

async function processarComandoPerfil(
  texto: string,
  usuario_id: string,
  perfil: UserProfile,
  memberName: string
): Promise<string | null> {
  const lower = texto.toLowerCase().trim();

  // ---- Comprador ----
  if (perfil === "comprador") {
    if (lower === "minhas demandas" || lower === "listar demandas") {
      return await comandoCompradorMinhasDemandas(usuario_id);
    }
    const matchAceitar = lower.match(/^aceitar\s+(.+)$/);
    if (matchAceitar) {
      return await comandoCompradorAceitar(matchAceitar[1].trim(), usuario_id);
    }
    if (lower === "me atualiza" || lower === "status") {
      return await comandoCompradorMeAtualiza(usuario_id);
    }
  }

  // ---- Fornecedor ----
  if (perfil === "fornecedor") {
    if (lower === "demandas" || lower === "oportunidades") {
      return await comandoFornecedorOportunidades(usuario_id);
    }
    if (lower === "me atualiza" || lower === "status") {
      return await comandoFornecedorMeAtualiza(usuario_id);
    }
    if (lower === "pedidos") {
      return await comandoFornecedorPedidos(usuario_id);
    }
    const matchNF = lower.match(/^nf\s+(.+)$/);
    if (matchNF) {
      return await comandoFornecedorNF(matchNF[1].trim(), usuario_id);
    }
  }

  // ---- Seller ----
  if (perfil === "seller") {
    if (lower === "me atualiza" || lower === "status") {
      return await comandoSellerMeAtualiza(usuario_id);
    }
    if (lower === "comissões" || lower === "comissoes") {
      return await comandoSellerComissoes(usuario_id);
    }
    if (lower === "clientes") {
      return await comandoSellerClientes(usuario_id);
    }
  }

  // ---- Originador ----
  if (perfil === "originador") {
    if (lower === "me atualiza" || lower === "status") {
      return await comandoOriginadorMeAtualiza(usuario_id);
    }
    if (lower === "comissões" || lower === "comissoes") {
      return await comandoOriginadorComissoes(usuario_id);
    }
    if (lower === "fornecedores") {
      return await comandoOriginadorFornecedores(usuario_id);
    }
  }

  // ---- Mesa ----
  if (perfil === "mesa") {
    if (lower === "pipeline") {
      return await comandoMesaPipeline();
    }
    if (lower === "aprovações" || lower === "aprovacoes") {
      return await comandoMesaAprovacoes();
    }
    const matchRejeitar = lower.match(/^rejeitar\s+(\S+)\s*(.*)$/);
    if (matchRejeitar) {
      return await comandoMesaRejeitar(matchRejeitar[1].trim(), matchRejeitar[2]?.trim() || "", usuario_id);
    }
    if (lower === "financeiro") {
      return await comandoMesaFinanceiro();
    }
    if (lower === "me atualiza" || lower === "status") {
      return await comandoMesaMeAtualiza(usuario_id);
    }
  }

  // No profile-specific command matched — fall through to conversational flow
  return null;
}

// ---------------------------------------------------------------------------
// Conversation engine
// ---------------------------------------------------------------------------

async function processarMensagem(texto: string, usuario_id: string): Promise<string> {
  const inicio = Date.now();
  const lower = texto.toLowerCase().trim();

  // ---- Detect user profile ----
  const { data: member } = await supabase
    .from("members")
    .select("id, tipo, nome")
    .eq("id", usuario_id)
    .single();
  const perfil: UserProfile = (member?.tipo as UserProfile) || "comprador";
  const memberName: string = member?.nome || "";

  // ---- Global commands ----
  if (lower === "cancelar" || lower === "sair") {
    await limparSessao(usuario_id);
    const resposta = "Demanda cancelada. Quando precisar, é só mandar mensagem!";
    await logIA(AGENTE, usuario_id, CANAL, texto, resposta, "cancelar", "sessao_limpa", true, Date.now() - inicio);
    return resposta;
  }

  if (lower === "foodhub me atualiza") {
    const resposta = await gerarDashboard(usuario_id);
    await logIA(AGENTE, usuario_id, CANAL, texto, resposta, "pedir_resumo", "dashboard", true, Date.now() - inicio);
    return resposta;
  }

  // ---- Profile-specific commands (before session/intent logic) ----
  const respostaPerfil = await processarComandoPerfil(texto, usuario_id, perfil, memberName);
  if (respostaPerfil) {
    await logIA(AGENTE, usuario_id, CANAL, texto, respostaPerfil, "comando_perfil", perfil, true, Date.now() - inicio);
    return respostaPerfil;
  }

  // ---- Load existing session ----
  let state = await carregarSessao(usuario_id);

  // ---- No session: identify intent ----
  if (!state) {
    const parsed = await identificarIntencaoEDados(texto, perfil);
    console.log(`[${AGENTE}] intencao=${parsed.intencao} produto=${parsed.produto} perfil=${perfil}`);

    if (parsed.intencao === "consultar_status") {
      const resposta = await consultarStatus(usuario_id);
      await logIA(AGENTE, usuario_id, CANAL, texto, resposta, "consultar_status", "query_demandas", true, Date.now() - inicio);
      return resposta;
    }

    if (parsed.intencao === "pedir_resumo") {
      const resposta = await gerarDashboard(usuario_id);
      await logIA(AGENTE, usuario_id, CANAL, texto, resposta, "pedir_resumo", "dashboard", true, Date.now() - inicio);
      return resposta;
    }

    if (parsed.intencao === "aprovar" && parsed.codigo_aprovacao) {
      const resposta = await processarAprovacao(parsed.codigo_aprovacao, usuario_id);
      await logIA(AGENTE, usuario_id, CANAL, texto, resposta, "aprovar", "aprovacao", true, Date.now() - inicio);
      return resposta;
    }

    if (parsed.intencao !== "criar_demanda") {
      const perfilDicas: Record<string, string> = {
        comprador: "Sugira criar uma demanda de compra ou consultar status das demandas existentes.",
        fornecedor: "Sugira ver oportunidades abertas (demandas) ou consultar pedidos.",
        seller: "Sugira consultar o pipeline de clientes ou ver comissões.",
        originador: "Sugira consultar deals dos fornecedores trazidos ou ver comissões.",
        mesa: "Sugira ver o pipeline, aprovações pendentes ou resumo financeiro.",
      };
      const dica = perfilDicas[perfil] || perfilDicas["comprador"];

      const resposta = await chamarClaude(
        `O usuário disse: "${texto}"`,
        `Você é o assistente do FoodHub, plataforma B2B de alimentos. ` +
        `O usuário tem perfil "${perfil}"${memberName ? ` e se chama ${memberName}` : ""}. ` +
        `Responda de forma profissional e direta, no idioma "${parsed.idioma}". ` +
        `${dica} ` +
        `Nunca mencione comissão, taxa ou fee. Nunca exponha outros compradores ou fornecedores. ` +
        `Máximo 2 parágrafos.`
      );
      await logIA(AGENTE, usuario_id, CANAL, texto, resposta, "desconhecida", "resposta_generica", true, Date.now() - inicio);
      return resposta;
    }

    // ---- Create demand flow ----
    state = novaConversacao();
    state.produto = parsed.produto;
    state.quantidade = parsed.quantidade;
    state.unidade = parsed.unidade;
    state.local_entrega = parsed.local_entrega;

    // Pre-populate any specs the user already mentioned
    if (parsed.specs_extraidos && typeof parsed.specs_extraidos === "object") {
      state.specs = { ...parsed.specs_extraidos };
    }

    // Classify product dynamically
    if (parsed.produto) {
      const classificacao = await classificarProduto(parsed.produto);
      state.categoria = classificacao.categoria;

      // Build pending fields, excluding what was already extracted
      state.campos_pendentes = construirCamposPendentes(
        classificacao.campos,
        state.specs
      );

      // Store campo definitions in specs under a meta key for later retrieval
      state.specs["__campos_produto"] = JSON.stringify(classificacao.campos);
      state.fase = "coletando_specs";
      state.step_atual = 0;

      await salvarSessao(usuario_id, state);

      let msg = `Entendi! Você precisa de *${state.produto}*`;
      if (state.quantidade) msg += ` — ${state.quantidade} ${state.unidade || "kg"}`;
      if (state.local_entrega) msg += ` em ${state.local_entrega}`;
      msg += ".\n\n";

      if (Object.keys(parsed.specs_extraidos || {}).length > 0) {
        msg += "Já anotei: ";
        const items = Object.entries(parsed.specs_extraidos || {})
          .map(([k, v]) => `${k}: ${v}`)
          .join(", ");
        msg += items + ".\n\n";
      }

      const totalSteps = state.campos_pendentes.length;
      if (totalSteps === 0) {
        // All specs already provided — check basics
        const perguntaBasica = proximaPerguntaBasica(state);
        if (perguntaBasica) {
          state.fase = "coletando_basicos";
          await salvarSessao(usuario_id, state);
          msg += perguntaBasica;
        } else {
          state.fase = "confirmacao";
          await salvarSessao(usuario_id, state);
          msg += formatarConfirmacao(state, obterCamposProduto(state));
        }
      } else {
        msg += "Preciso de algumas especificações:\n\n";
        msg += formatarPerguntas(state.campos_pendentes, obterCamposProduto(state), 0, totalSteps);
      }

      await logIA(AGENTE, usuario_id, CANAL, texto, msg, "criar_demanda", "sessao_criada", true, Date.now() - inicio);
      return msg;
    }

    // No product identified — ask
    state.fase = "identificacao";
    await salvarSessao(usuario_id, state);
    const resposta = "Qual produto você precisa comprar? Me diz o produto, quantidade e local de entrega.";
    await logIA(AGENTE, usuario_id, CANAL, texto, resposta, "criar_demanda", "pedindo_produto", true, Date.now() - inicio);
    return resposta;
  }

  // ---- Active session ----
  let resposta: string;

  switch (state.fase) {
    case "identificacao":
      resposta = await processarIdentificacao(texto, usuario_id, state);
      break;
    case "coletando_specs":
      resposta = await processarRespostaSpec(texto, usuario_id, state);
      break;
    case "coletando_basicos":
      resposta = await processarRespostaBasicos(texto, usuario_id, state);
      break;
    case "confirmacao":
      resposta = await processarConfirmacao(texto, usuario_id, state);
      break;
    default:
      await limparSessao(usuario_id);
      resposta = "Algo deu errado na conversa. Pode repetir o que precisa?";
  }

  await logIA(AGENTE, usuario_id, CANAL, texto, resposta, state.fase, "processamento", true, Date.now() - inicio);
  return resposta;
}

// ---------------------------------------------------------------------------
// Phase: Identification (product not yet known)
// ---------------------------------------------------------------------------

async function processarIdentificacao(
  texto: string,
  usuario_id: string,
  state: ConversationState
): Promise<string> {
  const parsed = await identificarIntencaoEDados(texto);

  if (!parsed.produto) {
    return "Não consegui identificar o produto. Pode me dizer o nome do produto que precisa?";
  }

  state.produto = parsed.produto;
  if (parsed.quantidade) state.quantidade = parsed.quantidade;
  if (parsed.unidade) state.unidade = parsed.unidade;
  if (parsed.local_entrega) state.local_entrega = parsed.local_entrega;
  if (parsed.specs_extraidos) {
    state.specs = { ...state.specs, ...parsed.specs_extraidos };
  }

  const classificacao = await classificarProduto(parsed.produto);
  state.categoria = classificacao.categoria;
  state.specs["__campos_produto"] = JSON.stringify(classificacao.campos);
  state.campos_pendentes = construirCamposPendentes(classificacao.campos, state.specs);
  state.fase = "coletando_specs";
  state.step_atual = 0;

  await salvarSessao(usuario_id, state);

  let msg = `Entendi: *${state.produto}*`;
  if (state.quantidade) msg += ` — ${state.quantidade} ${state.unidade || "kg"}`;
  if (state.local_entrega) msg += ` em ${state.local_entrega}`;
  msg += ".\n\n";

  const totalSteps = state.campos_pendentes.length;
  if (totalSteps === 0) {
    return await transicaoParaBasicosOuConfirmacao(msg, state, usuario_id);
  }

  msg += formatarPerguntas(state.campos_pendentes, obterCamposProduto(state), 0, totalSteps);
  return msg;
}

// ---------------------------------------------------------------------------
// Phase: Collecting specs
// ---------------------------------------------------------------------------

async function processarRespostaSpec(
  texto: string,
  usuario_id: string,
  state: ConversationState
): Promise<string> {
  const camposProduto = obterCamposProduto(state);

  if (state.campos_pendentes.length === 0) {
    return await transicaoParaBasicosOuConfirmacao("", state, usuario_id);
  }

  const campoAtualNome = state.campos_pendentes[0];
  const campoAtual = encontrarCampo(campoAtualNome, camposProduto);

  if (!campoAtual) {
    // Skip unknown field
    state.campos_pendentes.shift();
    await salvarSessao(usuario_id, state);
    return await avancarSpecs(state, usuario_id, camposProduto, "");
  }

  // Handle payment terms example request
  if (campoAtualNome === "prazo_pagamento") {
    const pedindoExemplo = ["exemplo", "sugestao", "sugestão", "como assim", "nao sei", "não sei", "opcoes", "opções"]
      .some((kw) => texto.toLowerCase().includes(kw));
    if (pedindoExemplo) {
      return "Alguns exemplos comuns no mercado:\n• 28 dias boleto\n• 30/60 DDL\n• À vista com desconto\n• 21 dias depósito\n\nComo prefere?";
    }
  }

  // Try to validate the current answer and potentially a second answer in the same message
  // (user might answer two questions at once)
  const valorValidado = await validarResposta(texto, campoAtual);

  if (!valorValidado) {
    const totalSteps = state.campos_pendentes.length + state.step_atual;
    return `Não entendi. Pode reformular?\n\n` +
      formatarPerguntas([campoAtualNome], camposProduto, state.step_atual, totalSteps);
  }

  // Save answer
  state.specs[campoAtualNome] = valorValidado;
  state.campos_pendentes.shift();
  state.step_atual++;

  // Build response prefix
  let resposta = `${valorValidado}.`;

  // Freight-specific notes
  if (campoAtualNome === "frete") {
    for (const [key, nota] of Object.entries(NOTAS_FRETE)) {
      if (valorValidado.toUpperCase().includes(key)) {
        resposta = nota;
        break;
      }
    }

    // After freight is chosen, re-evaluate pending fields
    // Add prazo_entrega_cif if CIF or Flexible
    if (valorValidado.toUpperCase().includes("CIF") || valorValidado.toUpperCase().includes("FLEX")) {
      if (!state.specs["prazo_entrega_cif"] && !state.campos_pendentes.includes("prazo_entrega_cif")) {
        // Insert after prazo_expedicao if present, otherwise at beginning
        const idxExpedicao = state.campos_pendentes.indexOf("prazo_expedicao");
        if (idxExpedicao >= 0) {
          state.campos_pendentes.splice(idxExpedicao + 1, 0, "prazo_entrega_cif");
        } else {
          state.campos_pendentes.unshift("prazo_entrega_cif");
        }
      }
    }
  }

  return await avancarSpecs(state, usuario_id, camposProduto, resposta);
}

async function avancarSpecs(
  state: ConversationState,
  usuario_id: string,
  camposProduto: CampoProduto[],
  respostaPrefixo: string
): Promise<string> {
  if (state.campos_pendentes.length === 0) {
    return await transicaoParaBasicosOuConfirmacao(
      respostaPrefixo ? respostaPrefixo + "\n\n" : "",
      state,
      usuario_id
    );
  }

  const totalSteps = state.campos_pendentes.length + state.step_atual;
  await salvarSessao(usuario_id, state);

  let msg = respostaPrefixo ? respostaPrefixo + "\n\n" : "";
  msg += formatarPerguntas(state.campos_pendentes, camposProduto, state.step_atual, totalSteps);
  return msg;
}

// ---------------------------------------------------------------------------
// Phase: Collecting basics (quantidade, unidade, local)
// ---------------------------------------------------------------------------

function proximaPerguntaBasica(state: ConversationState): string {
  const perguntas: string[] = [];
  if (!state.quantidade) perguntas.push("Qual a quantidade que precisa?");
  if (!state.unidade) perguntas.push("Em qual unidade? (kg, ton, un, cx)");
  if (!state.local_entrega) perguntas.push("Qual a cidade/estado de entrega?");

  // Max 2 questions
  return perguntas.slice(0, 2).join("\n");
}

async function processarRespostaBasicos(
  texto: string,
  usuario_id: string,
  state: ConversationState
): Promise<string> {
  const system = `O usuário respondeu em uma conversa de compra B2B de alimentos.
Dados atuais: quantidade=${state.quantidade}, unidade=${state.unidade}, local_entrega=${state.local_entrega}
Extraia os dados informados. Retorne SOMENTE JSON:
{"quantidade": number|null, "unidade": "kg"|"ton"|"un"|"cx"|null, "local_entrega": "string"|null}`;

  const resposta = await chamarClaude(`Resposta: "${texto}"`, system);
  try {
    const parsed = JSON.parse(resposta);
    if (parsed.quantidade && !state.quantidade) state.quantidade = parsed.quantidade;
    if (parsed.unidade && !state.unidade) state.unidade = parsed.unidade;
    if (parsed.local_entrega && !state.local_entrega) state.local_entrega = parsed.local_entrega;
  } catch {
    // Fallback: try to extract number
    if (!state.quantidade) {
      const num = parseFloat(texto.replace(",", "."));
      if (!isNaN(num)) state.quantidade = num;
    } else if (!state.local_entrega) {
      state.local_entrega = texto.trim();
    }
  }

  const pergunta = proximaPerguntaBasica(state);
  if (pergunta) {
    await salvarSessao(usuario_id, state);
    return pergunta;
  }

  // All basics complete — go to confirmation
  const camposProduto = obterCamposProduto(state);
  state.fase = "confirmacao";
  await salvarSessao(usuario_id, state);
  return formatarConfirmacao(state, camposProduto);
}

// ---------------------------------------------------------------------------
// Phase: Confirmation
// ---------------------------------------------------------------------------

async function processarConfirmacao(
  texto: string,
  usuario_id: string,
  state: ConversationState
): Promise<string> {
  const lower = texto.toLowerCase().trim();
  const sim = ["sim", "s", "yes", "confirma", "confirmar", "ok", "pode criar", "isso", "sí", "si"];
  const nao = ["nao", "não", "n", "no", "cancelar", "cancela"];

  if (nao.some((n) => lower.includes(n))) {
    await limparSessao(usuario_id);
    return "Demanda cancelada. Quando precisar, é só mandar mensagem!";
  }

  if (!sim.some((s) => lower.includes(s))) {
    return "Responda *SIM* para confirmar ou *NÃO* para cancelar.";
  }

  const resultado = await salvarDemanda(state, usuario_id);
  await limparSessao(usuario_id);

  if (!resultado.sucesso) {
    return "Desculpa, tive um problema ao registrar. Tenta de novo em instantes.";
  }

  const camposProduto = obterCamposProduto(state);
  let msg = `Demanda *${resultado.codigo}* criada com sucesso!\n\n`;
  msg += `*Produto:* ${state.produto || state.categoria}\n`;
  msg += `*Quantidade:* ${state.quantidade} ${state.unidade || "kg"}\n`;
  msg += `*Entrega:* ${state.local_entrega}\n`;

  if (Object.keys(state.specs).length > 0) {
    msg += "\n*Especificações:*\n";
    const todos = [...camposProduto, ...CAMPOS_UNIVERSAIS];
    for (const c of todos) {
      const valor = state.specs[c.campo];
      if (valor) {
        msg += `• ${c.label}: ${valor}\n`;
      }
    }
  }

  msg += `\nStatus: _aguardando aprovação da mesa_\n`;
  msg += "Já estou buscando fornecedores com match exato. Te aviso assim que tiver propostas!";
  return msg;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Retrieve product-specific campo definitions from session state. */
function obterCamposProduto(state: ConversationState): CampoProduto[] {
  const raw = state.specs["__campos_produto"];
  if (!raw) return [];
  try {
    return JSON.parse(raw) as CampoProduto[];
  } catch {
    return [];
  }
}

/** Transition from specs to basics or confirmation. */
async function transicaoParaBasicosOuConfirmacao(
  prefixo: string,
  state: ConversationState,
  usuario_id: string
): Promise<string> {
  const perguntaBasica = proximaPerguntaBasica(state);
  if (perguntaBasica) {
    state.fase = "coletando_basicos";
    await salvarSessao(usuario_id, state);
    return (prefixo ? prefixo : "") + "Especificações completas!\n\n" + perguntaBasica;
  }

  const camposProduto = obterCamposProduto(state);
  state.fase = "confirmacao";
  await salvarSessao(usuario_id, state);
  return (prefixo ? prefixo : "") + formatarConfirmacao(state, camposProduto);
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return corsResponse();
  }

  const inicio = Date.now();

  try {
    const { texto, usuario_id }: DealerRequest = await req.json();

    if (!texto || !usuario_id) {
      return jsonResponse(
        { erro: "Campos 'texto' e 'usuario_id' são obrigatórios" },
        400
      );
    }

    console.log(`[${AGENTE}] usuario=${usuario_id} texto="${texto.substring(0, 100)}"`);

    const resposta = await processarMensagem(texto, usuario_id);

    console.log(`[${AGENTE}] resposta em ${Date.now() - inicio}ms`);

    return jsonResponse({ resposta });
  } catch (err) {
    console.error(`[${AGENTE}] Erro:`, err);

    await logIA(
      AGENTE,
      null,
      CANAL,
      "erro_interno",
      String(err),
      "erro",
      "falha",
      false,
      Date.now() - inicio
    ).catch(() => {}); // Don't let logging failure mask the real error

    return jsonResponse(
      { erro: "Erro interno do agente", detalhe: String(err) },
      500
    );
  }
});
