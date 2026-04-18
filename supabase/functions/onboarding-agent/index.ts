/**
 * FoodHub V3 — Onboarding Agent
 * Handles new member registration via WhatsApp.
 * Collects data through multi-turn conversation and saves to
 * `members` + role-specific tables (compradores, fornecedores_v2, sellers, originadores).
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
// Types
// ---------------------------------------------------------------------------

interface OnboardingRequest {
  texto: string;
  usuario_id: string;
  tipo_perfil?: string;
}

type TipoPerfil = "comprador" | "fornecedor" | "seller" | "originador";

interface CampoDefinicao {
  campo: string;
  pergunta: string;
  validacao?: (v: string) => string | null; // returns cleaned value or null
}

interface OnboardingState {
  fase: "tipo_perfil" | "coletando" | "confirmacao";
  tipo_perfil: TipoPerfil | null;
  dados: Record<string, string>;
  step_atual: number;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Registration flows per profile type
// ---------------------------------------------------------------------------

const FLOWS: Record<TipoPerfil, CampoDefinicao[]> = {
  comprador: [
    {
      campo: "razao_social",
      pergunta: "Qual a razao social da empresa?",
    },
    {
      campo: "cnpj",
      pergunta: "Qual o CNPJ?",
      validacao: validarCNPJ,
    },
    {
      campo: "segmento",
      pergunta:
        "Qual o segmento de atuacao da empresa? (food service, varejo, atacado, trading, exportacao ou outro)",
    },
    {
      campo: "regioes_compra",
      pergunta: "Em quais regioes voce costuma comprar?",
    },
    {
      campo: "categorias_interesse",
      pergunta: "Quais categorias de produtos tem interesse? (carnes, graos, laticinios, etc.)",
    },
    {
      campo: "volume_mensal",
      pergunta: "Qual o volume medio mensal estimado de compras?",
    },
    {
      campo: "condicao_pagamento",
      pergunta: "Qual a condicao de pagamento usual? (ex: 28 dias boleto, a vista, etc.)",
    },
    {
      campo: "whatsapp",
      pergunta: "Qual seu WhatsApp para contato?",
    },
    {
      campo: "email",
      pergunta: "Qual seu email?",
      validacao: validarEmail,
    },
  ],

  fornecedor: [
    {
      campo: "razao_social",
      pergunta: "Qual a razao social da empresa?",
    },
    {
      campo: "cnpj",
      pergunta: "Qual o CNPJ?",
      validacao: validarCNPJ,
    },
    {
      campo: "categorias_produtos",
      pergunta: "Quais categorias e produtos voce fabrica? (pode descrever livremente)",
    },
    {
      campo: "regioes_atendimento",
      pergunta: "Quais regioes voce atende?",
    },
    {
      campo: "tipo_frete",
      pergunta: "Qual tipo de frete pratica? (CIF, FOB ou flexivel)",
    },
    {
      campo: "certificacoes",
      pergunta: "Possui certificacoes? Quais? (SIF, SISBI, ISO, BRC, ou nenhuma)",
    },
    {
      campo: "capacidade_produtiva",
      pergunta: "Qual a capacidade produtiva mensal e volume minimo por pedido?",
    },
    {
      campo: "whatsapp",
      pergunta: "Qual seu WhatsApp para contato?",
    },
    {
      campo: "email",
      pergunta: "Qual seu email?",
      validacao: validarEmail,
    },
  ],

  seller: [
    {
      campo: "nome",
      pergunta: "Qual seu nome completo?",
    },
    {
      campo: "documento",
      pergunta: "Qual seu CPF ou CNPJ?",
      validacao: validarDocumento,
    },
    {
      campo: "regioes_atuacao",
      pergunta: "Em quais regioes voce atua?",
    },
    {
      campo: "whatsapp",
      pergunta: "Qual seu WhatsApp para contato?",
    },
    {
      campo: "email",
      pergunta: "Qual seu email?",
      validacao: validarEmail,
    },
  ],

  originador: [
    {
      campo: "nome",
      pergunta: "Qual seu nome completo?",
    },
    {
      campo: "documento",
      pergunta: "Qual seu CPF ou CNPJ?",
      validacao: validarDocumento,
    },
    {
      campo: "whatsapp",
      pergunta: "Qual seu WhatsApp para contato?",
    },
    {
      campo: "email",
      pergunta: "Qual seu email?",
      validacao: validarEmail,
    },
  ],
};

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function validarCNPJ(valor: string): string | null {
  const digits = valor.replace(/\D/g, "");
  if (digits.length !== 14) return null;
  return digits;
}

function validarDocumento(valor: string): string | null {
  const digits = valor.replace(/\D/g, "");
  if (digits.length === 11 || digits.length === 14) return digits;
  return null;
}

function validarEmail(valor: string): string | null {
  const trimmed = valor.trim().toLowerCase();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return trimmed;
  return null;
}

// ---------------------------------------------------------------------------
// Session persistence (mensagens_v2, tipo='onboarding_session')
// ---------------------------------------------------------------------------

function novoEstado(): OnboardingState {
  return {
    fase: "tipo_perfil",
    tipo_perfil: null,
    dados: {},
    step_atual: 0,
    created_at: new Date().toISOString(),
  };
}

async function carregarSessao(usuario_id: string): Promise<OnboardingState | null> {
  const { data } = await supabase
    .from("mensagens_v2")
    .select("conteudo")
    .eq("remetente_id", usuario_id)
    .eq("tipo", "onboarding_session")
    .order("criado_em", { ascending: false })
    .limit(1)
    .single();

  if (!data?.conteudo) return null;
  try {
    const state: OnboardingState = JSON.parse(data.conteudo);
    // Sessions expire in 60 minutes
    if (Date.now() - new Date(state.created_at).getTime() > 60 * 60 * 1000) return null;
    return state;
  } catch {
    return null;
  }
}

async function salvarSessao(usuario_id: string, state: OnboardingState): Promise<void> {
  await supabase
    .from("mensagens_v2")
    .delete()
    .eq("remetente_id", usuario_id)
    .eq("tipo", "onboarding_session");

  await supabase.from("mensagens_v2").insert({
    remetente_id: usuario_id,
    tipo: "onboarding_session",
    conteudo: JSON.stringify({ ...state, created_at: new Date().toISOString() }),
    criado_em: new Date().toISOString(),
  });
}

async function limparSessao(usuario_id: string): Promise<void> {
  await supabase
    .from("mensagens_v2")
    .delete()
    .eq("remetente_id", usuario_id)
    .eq("tipo", "onboarding_session");
}

// ---------------------------------------------------------------------------
// AI helpers
// ---------------------------------------------------------------------------

const SYSTEM_ONBOARDING = `Voce e o assistente de cadastro do FoodHub, plataforma B2B de alimentos.
Regras:
- Tom profissional e acolhedor
- Nunca mencione comissao, taxa ou fee
- Maximo 2 perguntas por mensagem
- Detecte o idioma do usuario e responda no mesmo idioma
- Extraia o maximo de informacoes que o usuario fornecer de uma vez
- Se o usuario fornecer multiplos dados em uma unica mensagem, registre todos`;

async function classificarPerfil(texto: string): Promise<TipoPerfil | null> {
  const prompt = `O usuario quer se cadastrar no FoodHub e disse: "${texto}"

Classifique o tipo de perfil. Retorne SOMENTE um JSON:
{"tipo": "comprador" | "fornecedor" | "seller" | "originador" | null}

Regras:
- "comprador": quer comprar alimentos (food service, varejo, atacado, restaurante, hotel, trading, exportador)
- "fornecedor": fabrica/produz/fornece alimentos, industria alimenticia
- "seller": representante comercial, vendedor, broker
- "originador": indicador de negocios, quem traz oportunidades
- null: nao ficou claro

Retorne APENAS o JSON.`;

  const resposta = await chamarClaude(prompt, SYSTEM_ONBOARDING);
  try {
    const parsed = JSON.parse(resposta);
    if (["comprador", "fornecedor", "seller", "originador"].includes(parsed.tipo)) {
      return parsed.tipo as TipoPerfil;
    }
    return null;
  } catch {
    return null;
  }
}

async function classificarCategoriasFornecedor(texto: string): Promise<string> {
  const prompt = `O fornecedor descreveu seus produtos assim: "${texto}"

Classifique em categorias do mercado alimenticio. Retorne SOMENTE um JSON:
{"categorias": ["categoria1", "categoria2"], "produtos_detectados": ["produto1", "produto2"]}

Categorias possiveis: carnes_bovinas, carnes_suinas, aves, embutidos, laticinios, graos_cereais, oleos_gorduras, conservas, congelados, bebidas, hortifruti, pescados, panificacao, condimentos, outro

Retorne APENAS o JSON.`;

  const resposta = await chamarClaude(prompt, SYSTEM_ONBOARDING);
  try {
    const parsed = JSON.parse(resposta);
    return JSON.stringify(parsed);
  } catch {
    return JSON.stringify({ categorias: ["outro"], produtos_detectados: [texto] });
  }
}

async function extrairDadosMultiplos(
  texto: string,
  camposPendentes: CampoDefinicao[]
): Promise<Record<string, string>> {
  const camposDesc = camposPendentes
    .map((c) => `"${c.campo}": "${c.pergunta}"`)
    .join(",\n");

  const prompt = `O usuario respondeu: "${texto}"

Estamos coletando os seguintes dados para cadastro:
{${camposDesc}}

Extraia TODOS os dados que o usuario forneceu nesta mensagem.
Retorne SOMENTE um JSON com os campos encontrados. Exemplo:
{"campo1": "valor1", "campo2": "valor2"}

Se nenhum dado relevante foi encontrado, retorne {}.
Retorne APENAS o JSON.`;

  const resposta = await chamarClaude(prompt, SYSTEM_ONBOARDING);
  try {
    return JSON.parse(resposta);
  } catch {
    return {};
  }
}

async function gerarRespostaConversacional(
  contexto: string,
  perguntas: string[]
): Promise<string> {
  const perguntasTexto = perguntas.join("\n");
  const prompt = `${contexto}

Faca as seguintes perguntas de forma natural e acolhedora (maximo 2 por mensagem):
${perguntasTexto}

Regras:
- Tom profissional e amigavel
- Nao repita informacoes ja fornecidas
- Seja breve e direto
- Nunca mencione comissao ou taxa`;

  return await chamarClaude(prompt, SYSTEM_ONBOARDING);
}

// ---------------------------------------------------------------------------
// Core conversation engine
// ---------------------------------------------------------------------------

async function processarMensagem(
  texto: string,
  usuario_id: string,
  tipo_perfil_hint?: string
): Promise<string> {
  const inicio = Date.now();
  const lower = texto.toLowerCase().trim();

  // Global commands
  if (lower === "cancelar" || lower === "sair") {
    await limparSessao(usuario_id);
    return "Cadastro cancelado. Quando quiser retomar, e so mandar mensagem!";
  }

  let state = await carregarSessao(usuario_id);

  // -----------------------------------------------------------------------
  // No session: start onboarding
  // -----------------------------------------------------------------------
  if (!state) {
    state = novoEstado();

    // Try to detect profile from hint or text
    let perfil: TipoPerfil | null = null;
    if (tipo_perfil_hint && ["comprador", "fornecedor", "seller", "originador"].includes(tipo_perfil_hint)) {
      perfil = tipo_perfil_hint as TipoPerfil;
    } else {
      perfil = await classificarPerfil(texto);
    }

    if (perfil) {
      state.tipo_perfil = perfil;
      state.fase = "coletando";
      state.step_atual = 0;

      // Try extracting any data the user already provided
      const flow = FLOWS[perfil];
      const extraidos = await extrairDadosMultiplos(texto, flow);
      for (const [campo, valor] of Object.entries(extraidos)) {
        if (valor && flow.some((f) => f.campo === campo)) {
          const def = flow.find((f) => f.campo === campo)!;
          if (def.validacao) {
            const limpo = def.validacao(valor);
            if (limpo) state.dados[campo] = limpo;
          } else {
            state.dados[campo] = valor;
          }
        }
      }

      // Ask next pending questions (max 2)
      const pendentes = camposPendentes(state);
      if (pendentes.length === 0) {
        state.fase = "confirmacao";
        await salvarSessao(usuario_id, state);
        return formatarConfirmacao(state);
      }

      await salvarSessao(usuario_id, state);

      const labelPerfil = labelTipoPerfil(perfil);
      const proxPerguntas = pendentes.slice(0, 2).map((c) => c.pergunta);
      return await gerarRespostaConversacional(
        `O usuario quer se cadastrar como ${labelPerfil} no FoodHub. De as boas-vindas e faca as perguntas.`,
        proxPerguntas
      );
    }

    // Could not detect profile type
    state.fase = "tipo_perfil";
    await salvarSessao(usuario_id, state);
    return (
      "Bem-vindo ao FoodHub! Somos a mesa nacional de oportunidades do mercado de alimentos.\n\n" +
      "Para iniciar seu cadastro, me diz: voce e um *comprador*, *fornecedor*, *seller* (representante comercial) ou *originador* (indicador de negocios)?"
    );
  }

  // -----------------------------------------------------------------------
  // Active session: asking for profile type
  // -----------------------------------------------------------------------
  if (state.fase === "tipo_perfil") {
    const perfil = await classificarPerfil(texto);
    if (!perfil) {
      return "Nao consegui identificar. Voce quer se cadastrar como:\n\n1. *Comprador* (compra alimentos)\n2. *Fornecedor* (fabrica/produz alimentos)\n3. *Seller* (representante comercial)\n4. *Originador* (indicador de negocios)\n\nQual deles?";
    }

    state.tipo_perfil = perfil;
    state.fase = "coletando";
    state.step_atual = 0;
    await salvarSessao(usuario_id, state);

    const flow = FLOWS[perfil];
    const proxPerguntas = flow.slice(0, 2).map((c) => c.pergunta);
    const labelP = labelTipoPerfil(perfil);
    return await gerarRespostaConversacional(
      `Otimo! Cadastro como ${labelP}. Vamos comecar.`,
      proxPerguntas
    );
  }

  // -----------------------------------------------------------------------
  // Active session: collecting data
  // -----------------------------------------------------------------------
  if (state.fase === "coletando") {
    return await processarColeta(texto, usuario_id, state, inicio);
  }

  // -----------------------------------------------------------------------
  // Active session: confirmation
  // -----------------------------------------------------------------------
  if (state.fase === "confirmacao") {
    return await processarConfirmacao(texto, usuario_id, state, inicio);
  }

  await limparSessao(usuario_id);
  return "Algo deu errado. Vamos recomecar — me diz como posso te ajudar com o cadastro?";
}

// ---------------------------------------------------------------------------
// Data collection phase
// ---------------------------------------------------------------------------

async function processarColeta(
  texto: string,
  usuario_id: string,
  state: OnboardingState,
  inicio: number
): Promise<string> {
  const perfil = state.tipo_perfil!;
  const flow = FLOWS[perfil];
  const pendentes = camposPendentes(state);

  if (pendentes.length === 0) {
    state.fase = "confirmacao";
    await salvarSessao(usuario_id, state);
    return formatarConfirmacao(state);
  }

  // Try to extract multiple fields at once
  const extraidos = await extrairDadosMultiplos(texto, pendentes);
  let algumExtraido = false;

  for (const [campo, valor] of Object.entries(extraidos)) {
    if (!valor) continue;
    const def = flow.find((f) => f.campo === campo);
    if (!def) continue;

    if (def.validacao) {
      const limpo = def.validacao(String(valor));
      if (limpo) {
        state.dados[campo] = limpo;
        algumExtraido = true;
      }
    } else {
      state.dados[campo] = String(valor);
      algumExtraido = true;
    }
  }

  // If nothing extracted via AI, try direct assignment to current pending field
  if (!algumExtraido && pendentes.length > 0) {
    const campoAtual = pendentes[0];
    const textoLimpo = texto.trim();

    if (campoAtual.validacao) {
      const limpo = campoAtual.validacao(textoLimpo);
      if (limpo) {
        state.dados[campoAtual.campo] = limpo;
        algumExtraido = true;
      } else {
        await salvarSessao(usuario_id, state);
        return `O dado informado nao parece valido. ${campoAtual.pergunta}`;
      }
    } else {
      state.dados[campoAtual.campo] = textoLimpo;
      algumExtraido = true;
    }
  }

  // Classify supplier products if applicable
  if (
    perfil === "fornecedor" &&
    state.dados.categorias_produtos &&
    !state.dados._categorias_classificadas
  ) {
    const classificacao = await classificarCategoriasFornecedor(state.dados.categorias_produtos);
    state.dados._categorias_classificadas = classificacao;
  }

  // Check remaining fields
  const novosPendentes = camposPendentes(state);

  if (novosPendentes.length === 0) {
    state.fase = "confirmacao";
    await salvarSessao(usuario_id, state);
    return formatarConfirmacao(state);
  }

  await salvarSessao(usuario_id, state);

  const proxPerguntas = novosPendentes.slice(0, 2).map((c) => c.pergunta);
  const camposPreenchidos = Object.keys(state.dados).filter((k) => !k.startsWith("_")).length;
  const totalCampos = flow.length;

  return await gerarRespostaConversacional(
    `Dados registrados (${camposPreenchidos}/${totalCampos}). Continue coletando os dados pendentes.`,
    proxPerguntas
  );
}

// ---------------------------------------------------------------------------
// Confirmation phase
// ---------------------------------------------------------------------------

function formatarConfirmacao(state: OnboardingState): string {
  const perfil = state.tipo_perfil!;
  const label = labelTipoPerfil(perfil);
  const flow = FLOWS[perfil];

  let msg = `Perfeito! Confira seus dados de cadastro como *${label}*:\n\n`;
  for (const campo of flow) {
    const valor = state.dados[campo.campo];
    if (valor) {
      msg += `• ${labelCampo(campo.campo)}: ${valor}\n`;
    }
  }
  msg += `\nTudo certo? Responda *SIM* para confirmar ou *NAO* para cancelar.`;
  return msg;
}

async function processarConfirmacao(
  texto: string,
  usuario_id: string,
  state: OnboardingState,
  inicio: number
): Promise<string> {
  const lower = texto.toLowerCase().trim();
  const sim = ["sim", "s", "yes", "confirma", "confirmar", "ok", "pode", "isso", "correto"];
  const nao = ["nao", "não", "n", "no", "cancelar", "cancela"];

  if (nao.some((n) => lower.includes(n))) {
    await limparSessao(usuario_id);
    await logIA("onboarding-agent", usuario_id, "whatsapp", texto, "cancelado", "cadastro", "cancelamento", true, Date.now() - inicio);
    return "Cadastro cancelado. Quando quiser retomar, e so mandar mensagem!";
  }

  if (!sim.some((s) => lower.includes(s))) {
    return "Responda *SIM* para confirmar o cadastro ou *NAO* para cancelar.";
  }

  // --- Save member ---
  try {
    const perfil = state.tipo_perfil!;
    const codigo = await gerarCodigo("MBR", "members");

    // Build member record
    const memberRecord: Record<string, unknown> = {
      tipo: perfil,
      status: "aguardando_aprovacao",
      codigo,
      whatsapp: state.dados.whatsapp || null,
      email: state.dados.email || null,
      criado_em: new Date().toISOString(),
      usuario_id,
    };

    // Add name/razao_social based on profile
    if (perfil === "comprador" || perfil === "fornecedor") {
      memberRecord.nome = state.dados.razao_social || null;
      memberRecord.cnpj = state.dados.cnpj || null;
    } else {
      memberRecord.nome = state.dados.nome || null;
      memberRecord.documento = state.dados.documento || null;
    }

    const { data: memberData, error: memberError } = await supabase
      .from("members")
      .insert(memberRecord)
      .select("id")
      .single();

    if (memberError) throw memberError;

    const memberId = memberData.id;

    // Save to role-specific table
    await salvarDadosEspecificos(perfil, memberId, state.dados);

    // Create approval
    await criarAprovacao("membro", memberId, codigo);

    // Log
    await logIA(
      "onboarding-agent",
      usuario_id,
      "whatsapp",
      texto,
      `Cadastro ${perfil} criado: ${codigo}`,
      "cadastro",
      "registro_completo",
      true,
      Date.now() - inicio
    );

    await limparSessao(usuario_id);

    return "Cadastro recebido! Nosso time vai analisar e te retorno em breve.";
  } catch (err) {
    console.error("[onboarding-agent] Erro ao salvar cadastro:", err);
    await logIA(
      "onboarding-agent",
      usuario_id,
      "whatsapp",
      texto,
      `Erro: ${String(err)}`,
      "cadastro",
      "erro_salvamento",
      false,
      Date.now() - inicio
    );
    return "Desculpe, tive um problema ao registrar seu cadastro. Tente novamente em instantes.";
  }
}

// ---------------------------------------------------------------------------
// Save to role-specific tables
// ---------------------------------------------------------------------------

async function salvarDadosEspecificos(
  perfil: TipoPerfil,
  memberId: string,
  dados: Record<string, string>
): Promise<void> {
  switch (perfil) {
    case "comprador": {
      await supabase.from("compradores").insert({
        member_id: memberId,
        razao_social: dados.razao_social || null,
        cnpj: dados.cnpj || null,
        segmento: dados.segmento || null,
        regioes_compra: dados.regioes_compra || null,
        categorias_interesse: dados.categorias_interesse || null,
        volume_mensal: dados.volume_mensal || null,
        condicao_pagamento: dados.condicao_pagamento || null,
        criado_em: new Date().toISOString(),
      });
      break;
    }

    case "fornecedor": {
      const classificacao = dados._categorias_classificadas
        ? JSON.parse(dados._categorias_classificadas)
        : null;

      await supabase.from("fornecedores_v2").insert({
        member_id: memberId,
        razao_social: dados.razao_social || null,
        cnpj: dados.cnpj || null,
        categorias_produtos: dados.categorias_produtos || null,
        categorias_classificadas: classificacao?.categorias || null,
        produtos_detectados: classificacao?.produtos_detectados || null,
        regioes_atendimento: dados.regioes_atendimento || null,
        tipo_frete: dados.tipo_frete || null,
        certificacoes: dados.certificacoes || null,
        capacidade_produtiva: dados.capacidade_produtiva || null,
        criado_em: new Date().toISOString(),
      });
      break;
    }

    case "seller": {
      await supabase.from("sellers").insert({
        member_id: memberId,
        nome: dados.nome || null,
        documento: dados.documento || null,
        regioes_atuacao: dados.regioes_atuacao || null,
        criado_em: new Date().toISOString(),
      });
      break;
    }

    case "originador": {
      await supabase.from("originadores").insert({
        member_id: memberId,
        nome: dados.nome || null,
        documento: dados.documento || null,
        criado_em: new Date().toISOString(),
      });
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function camposPendentes(state: OnboardingState): CampoDefinicao[] {
  const flow = FLOWS[state.tipo_perfil!];
  return flow.filter((c) => !state.dados[c.campo]);
}

function labelTipoPerfil(tipo: TipoPerfil): string {
  const labels: Record<TipoPerfil, string> = {
    comprador: "Comprador",
    fornecedor: "Fornecedor",
    seller: "Seller (Representante Comercial)",
    originador: "Originador",
  };
  return labels[tipo];
}

function labelCampo(campo: string): string {
  const labels: Record<string, string> = {
    razao_social: "Razao Social",
    cnpj: "CNPJ",
    segmento: "Segmento",
    regioes_compra: "Regioes de Compra",
    categorias_interesse: "Categorias de Interesse",
    volume_mensal: "Volume Mensal",
    condicao_pagamento: "Condicao de Pagamento",
    categorias_produtos: "Categorias/Produtos",
    regioes_atendimento: "Regioes de Atendimento",
    tipo_frete: "Tipo de Frete",
    certificacoes: "Certificacoes",
    capacidade_produtiva: "Capacidade Produtiva",
    nome: "Nome",
    documento: "CPF/CNPJ",
    regioes_atuacao: "Regioes de Atuacao",
    whatsapp: "WhatsApp",
    email: "Email",
  };
  return labels[campo] || campo;
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return corsResponse();
  }

  const inicio = Date.now();

  try {
    const { texto, usuario_id, tipo_perfil }: OnboardingRequest = await req.json();

    if (!texto || !usuario_id) {
      return jsonResponse(
        { erro: "Campos 'texto' e 'usuario_id' sao obrigatorios" },
        400
      );
    }

    console.log(`[onboarding-agent] usuario=${usuario_id} texto="${texto}" perfil_hint=${tipo_perfil || "none"}`);

    const resposta = await processarMensagem(texto, usuario_id, tipo_perfil);

    return jsonResponse({ resposta });
  } catch (err) {
    console.error("[onboarding-agent] Erro:", err);
    await logIA(
      "onboarding-agent",
      null,
      "whatsapp",
      "",
      `Erro nao tratado: ${String(err)}`,
      "erro",
      "erro_handler",
      false,
      Date.now() - inicio
    );
    return jsonResponse(
      { erro: "Erro interno do agente", detalhe: String(err) },
      500
    );
  }
});
