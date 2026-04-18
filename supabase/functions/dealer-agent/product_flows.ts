/**
 * FoodHub — Product Flows V2
 *
 * Fluxo de perguntas obrigatórias por categoria de produto.
 * Cada categoria tem especificações técnicas + logística + comercial.
 *
 * Decisão arquitetural: separar perguntas em 3 blocos:
 * 1. Specs técnicas (variam por categoria)
 * 2. Logística (frete + prazo expedição — quase universal)
 * 3. Comercial (prazo pagamento — universal)
 *
 * Perguntas de frete e prazo são condicionais:
 * - FOB: informar que prazo de chegada é responsabilidade do comprador
 * - CIF: prazo inclui entrega na porta
 * - Flexível: registrar preferência
 */

// --- Tipos ---

export interface FlowStep {
  campo: string;
  pergunta: string;
  /** Opções sugeridas — se vazio, pergunta aberta */
  opcoes: string[];
  aceita_outro: boolean;
  /** Se true, pergunta é aberta (sem opções fixas). Exemplos só se o cliente pedir. */
  aberta: boolean;
  /** Mensagem complementar após a resposta (ex: aviso FOB) */
  nota_condicional?: Record<string, string>;
}

export interface ProductFlow {
  categoria: string;
  keywords: string[];
  steps: FlowStep[];
}

// --- Steps universais: logística + comercial ---
// Adicionados ao final de cada flow de categoria

const STEPS_LOGISTICA: FlowStep[] = [
  {
    campo: "frete",
    pergunta: "Tipo de frete?",
    opcoes: ["CIF (entrega na porta)", "FOB (retira na fábrica)", "Flexível"],
    aceita_outro: false,
    aberta: false,
    nota_condicional: {
      "FOB": "O prazo de chegada fica por sua conta apos a retirada na fabrica.",
      "CIF": "A industria sera responsavel pela entrega completa ate voce.",
    },
  },
  {
    campo: "prazo_expedicao",
    pergunta: "Em quantos dias uteis voce precisa que a industria fature e despache?",
    opcoes: ["3 dias uteis", "5 dias uteis", "7 dias uteis", "10 dias uteis"],
    aceita_outro: true,
    aberta: false,
  },
  {
    campo: "prazo_pagamento",
    pergunta: "Qual sua condicao de pagamento?",
    opcoes: [],
    aceita_outro: true,
    aberta: true,
    // Nota: exemplos só se o cliente pedir. O agente NÃO lista opções por padrão.
  },
];

const STEP_CERTIFICACAO: FlowStep = {
  campo: "certificacao",
  pergunta: "Exigencia de certificacao?",
  opcoes: ["GFSI", "FSSC 22000", "sem exigencia"],
  aceita_outro: true,
  aberta: false,
};

// --- Flows por categoria ---

export const PRODUCT_FLOWS: ProductFlow[] = [
  {
    categoria: "frango_sassami",
    keywords: ["sassami", "sasami", "frango sassami"],
    steps: [
      {
        campo: "corte",
        pergunta: "Qual o tipo de corte/apresentacao?",
        opcoes: ["IQF", "bandeja", "vacuo", "desfiado"],
        aceita_outro: true,
        aberta: false,
      },
      {
        campo: "conservacao",
        pergunta: "Conservacao?",
        opcoes: ["congelado", "resfriado"],
        aceita_outro: false,
        aberta: false,
      },
      {
        campo: "embalagem_individual",
        pergunta: "Embalagem individual (peso por unidade)?",
        opcoes: ["500g", "1kg", "2kg", "granel"],
        aceita_outro: true,
        aberta: false,
      },
      {
        campo: "embalagem_master",
        pergunta: "Embalagem master (caixa)?",
        opcoes: ["caixa 10kg", "caixa 15kg", "caixa 20kg"],
        aceita_outro: true,
        aberta: false,
      },
      ...STEPS_LOGISTICA,
      STEP_CERTIFICACAO,
    ],
  },
  {
    categoria: "frango_file_peito",
    keywords: ["file de frango", "filé de frango", "peito de frango", "file peito", "filé peito"],
    steps: [
      {
        campo: "conservacao",
        pergunta: "Conservacao?",
        opcoes: ["congelado", "resfriado"],
        aceita_outro: false,
        aberta: false,
      },
      {
        campo: "embalagem_individual",
        pergunta: "Embalagem individual?",
        opcoes: ["500g", "1kg", "2kg", "granel"],
        aceita_outro: true,
        aberta: false,
      },
      {
        campo: "embalagem_master",
        pergunta: "Embalagem master?",
        opcoes: ["caixa 10kg", "caixa 15kg", "caixa 20kg"],
        aceita_outro: true,
        aberta: false,
      },
      ...STEPS_LOGISTICA,
      STEP_CERTIFICACAO,
    ],
  },
  {
    categoria: "frango_generico",
    keywords: ["frango", "coxa", "sobrecoxa", "asa", "frango inteiro", "dorso", "meio da asa"],
    steps: [
      {
        campo: "corte",
        pergunta: "Qual o corte?",
        opcoes: ["coxa", "sobrecoxa", "asa", "meio da asa", "frango inteiro", "dorso"],
        aceita_outro: true,
        aberta: false,
      },
      {
        campo: "conservacao",
        pergunta: "Conservacao?",
        opcoes: ["congelado", "resfriado"],
        aceita_outro: false,
        aberta: false,
      },
      {
        campo: "embalagem_individual",
        pergunta: "Embalagem individual?",
        opcoes: ["500g", "1kg", "2kg", "granel"],
        aceita_outro: true,
        aberta: false,
      },
      {
        campo: "embalagem_master",
        pergunta: "Embalagem master?",
        opcoes: ["caixa 10kg", "caixa 15kg", "caixa 20kg"],
        aceita_outro: true,
        aberta: false,
      },
      ...STEPS_LOGISTICA,
      STEP_CERTIFICACAO,
    ],
  },
  {
    categoria: "calabresa",
    keywords: ["calabresa", "linguiça calabresa", "linguica calabresa"],
    steps: [
      {
        campo: "tipo",
        pergunta: "Qual o tipo?",
        opcoes: ["defumada", "curada", "frescal"],
        aceita_outro: true,
        aberta: false,
      },
      {
        campo: "embalagem_master",
        pergunta: "Embalagem master?",
        opcoes: ["caixa 10kg", "caixa 15kg", "caixa 20kg"],
        aceita_outro: true,
        aberta: false,
      },
      ...STEPS_LOGISTICA,
    ],
  },
  {
    categoria: "salsicha",
    keywords: ["salsicha", "hot dog", "salsichao"],
    steps: [
      {
        campo: "tipo",
        pergunta: "Qual o tipo?",
        opcoes: ["tradicional", "de frango", "mista", "viena"],
        aceita_outro: true,
        aberta: false,
      },
      {
        campo: "embalagem_individual",
        pergunta: "Embalagem individual?",
        opcoes: ["500g", "1kg", "3kg", "granel"],
        aceita_outro: true,
        aberta: false,
      },
      {
        campo: "embalagem_master",
        pergunta: "Embalagem master?",
        opcoes: ["caixa 10kg", "caixa 15kg", "caixa 20kg"],
        aceita_outro: true,
        aberta: false,
      },
      ...STEPS_LOGISTICA,
    ],
  },
  {
    categoria: "carne_bovina",
    keywords: ["carne", "bovina", "boi", "picanha", "alcatra", "patinho", "acem", "costela", "dianteiro", "traseiro", "charque"],
    steps: [
      {
        campo: "corte",
        pergunta: "Qual o corte?",
        opcoes: ["dianteiro", "traseiro", "picanha", "alcatra", "patinho", "acem", "costela", "charque"],
        aceita_outro: true,
        aberta: false,
      },
      {
        campo: "conservacao",
        pergunta: "Conservacao?",
        opcoes: ["congelado", "resfriado", "salgado/curado"],
        aceita_outro: false,
        aberta: false,
      },
      {
        campo: "embalagem",
        pergunta: "Tipo de embalagem?",
        opcoes: ["vacuo", "bandeja", "a granel"],
        aceita_outro: true,
        aberta: false,
      },
      ...STEPS_LOGISTICA,
      {
        campo: "certificacao",
        pergunta: "Exigencia de certificacao ou selo?",
        opcoes: ["SIF", "GFSI", "Angus Certified", "sem exigencia"],
        aceita_outro: true,
        aberta: false,
      },
    ],
  },
  {
    categoria: "arroz",
    keywords: ["arroz", "arroz tipo 1", "arroz parboilizado", "arroz integral", "arroz agulhinha"],
    steps: [
      {
        campo: "tipo",
        pergunta: "Qual o tipo do arroz?",
        opcoes: ["tipo 1 (agulhinha)", "parboilizado", "integral", "arboreo"],
        aceita_outro: true,
        aberta: false,
      },
      {
        campo: "embalagem",
        pergunta: "Embalagem?",
        opcoes: ["1kg", "2kg", "5kg", "fardo 30kg"],
        aceita_outro: true,
        aberta: false,
      },
      ...STEPS_LOGISTICA,
      {
        campo: "certificacao",
        pergunta: "Exigencia de certificacao?",
        opcoes: ["organico", "sem exigencia"],
        aceita_outro: true,
        aberta: false,
      },
    ],
  },
  {
    categoria: "oleo_gordura",
    keywords: ["oleo", "óleo", "gordura", "azeite", "banha", "margarina", "oleo de soja", "oleo de canola"],
    steps: [
      {
        campo: "tipo",
        pergunta: "Qual o tipo?",
        opcoes: ["oleo de soja", "oleo de canola", "azeite de oliva", "gordura vegetal", "banha"],
        aceita_outro: true,
        aberta: false,
      },
      {
        campo: "embalagem",
        pergunta: "Embalagem?",
        opcoes: ["900ml PET", "lata 500ml", "galao 5L", "tambor 200L", "a granel"],
        aceita_outro: true,
        aberta: false,
      },
      ...STEPS_LOGISTICA,
    ],
  },
];

/**
 * Encontra o flow mais específico para a categoria.
 * Prioriza match exato (frango_sassami) sobre genérico (frango_generico).
 */
export function encontrarFlow(categoria: string): ProductFlow | null {
  const lower = categoria.toLowerCase().replace(/\s+/g, "_");
  // Match exato primeiro
  const exato = PRODUCT_FLOWS.find((f) => f.categoria === lower);
  if (exato) return exato;
  // Match por keyword
  return PRODUCT_FLOWS.find(
    (f) => f.keywords.some((kw) => lower.includes(kw.replace(/\s+/g, "_")) || kw.replace(/\s+/g, "_").includes(lower))
  ) || null;
}

/**
 * Encontra flow por texto livre do usuário.
 * Prioriza categorias mais específicas (sassami antes de frango genérico).
 */
export function encontrarFlowPorTexto(texto: string): ProductFlow | null {
  const lower = texto.toLowerCase();
  // Buscar match mais específico primeiro (flows estão ordenados do mais específico ao mais genérico)
  return PRODUCT_FLOWS.find(
    (f) => f.keywords.some((kw) => lower.includes(kw))
  ) || null;
}

/**
 * Formata a pergunta de um step para envio no WhatsApp.
 * Regra: perguntas abertas não listam opções por padrão.
 */
export function formatarPerguntaStep(step: FlowStep, stepNum: number, totalSteps: number): string {
  let msg = `(${stepNum}/${totalSteps}) ${step.pergunta}\n`;

  if (!step.aberta && step.opcoes.length > 0) {
    msg += `\n`;
    step.opcoes.forEach((op, i) => {
      msg += `${i + 1}. ${op}\n`;
    });
    if (step.aceita_outro) {
      msg += `\nOu digite outro valor.`;
    }
  }
  // Perguntas abertas: sem opções listadas. Exemplos só se o cliente pedir.

  return msg;
}
