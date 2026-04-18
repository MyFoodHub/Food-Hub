/**
 * FoodHub Dealer Agent — Teste local V2
 * Fluxo multi-turno com frete, prazo expedição, prazo pagamento.
 */

import {
  encontrarFlowPorTexto,
  formatarPerguntaStep,
  type ProductFlow,
} from "./product_flows.ts";

const PORT = 54321;

// Estado em memória por usuario
const sessions: Map<string, {
  fase: string;
  produto: string | null;
  categoria: string | null;
  quantidade: number | null;
  unidade: string | null;
  local_entrega: string | null;
  step_atual: number;
  specs: Record<string, string>;
  flow: ProductFlow | null;
}> = new Map();

function processarMensagem(texto: string, usuario_id: string): { resposta: string; state: unknown } {
  const lower = texto.toLowerCase().trim();

  if (lower === "cancelar" || lower === "sair") {
    sessions.delete(usuario_id);
    return { resposta: "Demanda cancelada. Quando precisar, e so mandar mensagem!", state: null };
  }

  let session = sessions.get(usuario_id);

  // --- Sem sessão ---
  if (!session) {
    if (lower.includes("status") || lower.includes("minha demanda")) {
      return { resposta: "[MOCK] Suas demandas:\n• Frango Sassami — 10 ton — aberta (2 propostas)", state: null };
    }
    if (lower.includes("resumo")) {
      return { resposta: "[MOCK] Resumo: 3 demandas, 7 propostas, 12 fornecedores", state: null };
    }

    const flow = encontrarFlowPorTexto(texto);
    const matchQtd = lower.match(/(\d+)\s*(ton|kg|un|cx)/);
    const matchLocal = lower.match(/(?:em|para)\s+([a-záéíóúãõç\s]+)$/i);
    const matchProduto = lower.match(/(?:preciso|quero|comprar)\s+(?:de\s+)?(?:\d+\s*(?:ton|kg|un|cx)\s*(?:de\s+)?)?(.+?)(?:\s+em\s+|\s+para\s+|$)/);

    session = {
      fase: flow ? "coletando_specs" : "coletando_basicos",
      produto: matchProduto?.[1]?.trim() || "produto",
      categoria: flow?.categoria || null,
      quantidade: matchQtd ? parseInt(matchQtd[1]) : null,
      unidade: matchQtd?.[2] || null,
      local_entrega: matchLocal?.[1]?.trim() || null,
      step_atual: 0,
      specs: {},
      flow,
    };

    if (flow) {
      sessions.set(usuario_id, session);
      const step = flow.steps[0];
      let msg = `Entendi! Voce precisa de *${session.produto}*`;
      if (session.quantidade) msg += ` — ${session.quantidade} ${session.unidade}`;
      if (session.local_entrega) msg += ` em ${session.local_entrega}`;
      msg += `.\n\nPreciso de algumas especificacoes:\n\n`;
      msg += formatarPerguntaStep(step, 1, flow.steps.length);
      return { resposta: msg, state: session };
    }

    sessions.set(usuario_id, session);
    if (!session.quantidade) return { resposta: "Qual a quantidade que precisa?", state: session };
    if (!session.local_entrega) return { resposta: "Qual a cidade/estado de entrega?", state: session };
    session.fase = "confirmacao";
    sessions.set(usuario_id, session);
    return { resposta: formatarConfirmacao(session), state: session };
  }

  // --- Coletando specs ---
  if (session.fase === "coletando_specs" && session.flow) {
    const step = session.flow.steps[session.step_atual];

    // Verificar pedido de exemplos para pergunta aberta
    if (step.aberta && step.campo === "prazo_pagamento") {
      if (["exemplo", "sugestao", "nao sei", "opcoes"].some((kw) => lower.includes(kw))) {
        return {
          resposta: "Alguns exemplos comuns:\n• 28 dias boleto\n• 30/60 DDL\n• A vista com desconto\n\nComo prefere?",
          state: session,
        };
      }
    }

    // Mapear número para opção
    let valor = texto.trim();
    const num = parseInt(valor);
    if (!step.aberta && num >= 1 && num <= step.opcoes.length) {
      valor = step.opcoes[num - 1];
    }

    session.specs[step.campo] = valor;
    session.step_atual++;

    // Nota condicional (FOB/CIF)
    let notaExtra = "";
    if (step.nota_condicional) {
      for (const [chave, nota] of Object.entries(step.nota_condicional)) {
        if (valor.toUpperCase().includes(chave.toUpperCase())) {
          notaExtra = ` ${nota}`;
          break;
        }
      }
    }

    if (session.step_atual < session.flow.steps.length) {
      sessions.set(usuario_id, session);
      const proxStep = session.flow.steps[session.step_atual];
      let msg = `${valor}.${notaExtra}\n\n`;
      msg += formatarPerguntaStep(proxStep, session.step_atual + 1, session.flow.steps.length);
      return { resposta: msg, state: session };
    }

    // Specs completas
    if (!session.quantidade) {
      session.fase = "coletando_basicos";
      sessions.set(usuario_id, session);
      return { resposta: `${valor}.${notaExtra}\n\nEspecificacoes completas! Qual a quantidade?`, state: session };
    }
    if (!session.local_entrega) {
      session.fase = "coletando_basicos";
      sessions.set(usuario_id, session);
      return { resposta: `${valor}.${notaExtra}\n\nEspecificacoes completas! Qual a cidade/estado de entrega?`, state: session };
    }

    session.fase = "confirmacao";
    sessions.set(usuario_id, session);
    return { resposta: `${valor}.${notaExtra}\n\n` + formatarConfirmacao(session), state: session };
  }

  // --- Coletando básicos ---
  if (session.fase === "coletando_basicos") {
    if (!session.quantidade) {
      const matchQtd = lower.match(/(\d+)\s*(ton|kg|un|cx)?/);
      if (matchQtd) {
        session.quantidade = parseInt(matchQtd[1]);
        session.unidade = matchQtd[2] || "kg";
      } else {
        return { resposta: "Nao entendi. Qual a quantidade? (ex: 10 ton, 500 kg)", state: session };
      }
    }
    if (!session.local_entrega) {
      if (texto.trim()) {
        session.local_entrega = texto.trim();
      } else {
        return { resposta: "Qual a cidade/estado de entrega?", state: session };
      }
    }

    if (!session.quantidade || !session.local_entrega) {
      sessions.set(usuario_id, session);
      if (!session.quantidade) return { resposta: "Qual a quantidade?", state: session };
      return { resposta: "Qual a cidade/estado de entrega?", state: session };
    }

    session.fase = "confirmacao";
    sessions.set(usuario_id, session);
    return { resposta: formatarConfirmacao(session), state: session };
  }

  // --- Confirmação ---
  if (session.fase === "confirmacao") {
    if (["sim", "s", "ok", "confirma", "yes"].some((s) => lower.includes(s))) {
      let msg = `[MOCK] Demanda criada com sucesso!\n\n`;
      msg += `Produto: ${session.produto}\n`;
      msg += `Quantidade: ${session.quantidade} ${session.unidade}\n`;
      msg += `Entrega: ${session.local_entrega}\n`;
      if (session.flow && Object.keys(session.specs).length > 0) {
        msg += `\nEspecificacoes:\n`;
        for (const step of session.flow.steps) {
          const valor = session.specs[step.campo];
          if (valor) {
            const label = step.pergunta.replace("?", "").replace(/\(.*\)/, "").trim();
            msg += `• ${label}: ${valor}\n`;
          }
        }
      }
      msg += `\nJa estou buscando fornecedores com match exato!`;
      sessions.delete(usuario_id);
      return { resposta: msg, state: null };
    }
    if (["nao", "não", "n", "cancelar"].some((n) => lower.includes(n))) {
      sessions.delete(usuario_id);
      return { resposta: "Demanda cancelada.", state: null };
    }
    return { resposta: "Responda SIM para confirmar ou NAO para cancelar.", state: session };
  }

  sessions.delete(usuario_id);
  return { resposta: "Algo deu errado. Pode repetir?", state: null };
}

function formatarConfirmacao(session: NonNullable<ReturnType<typeof sessions.get>>): string {
  let msg = `Confirma sua demanda?\n\n`;
  msg += `Produto: ${session.produto}\n`;
  msg += `Quantidade: ${session.quantidade} ${session.unidade}\n`;
  msg += `Entrega: ${session.local_entrega}\n`;
  if (session.flow && Object.keys(session.specs).length > 0) {
    msg += `\nEspecificacoes:\n`;
    for (const step of session.flow.steps) {
      const valor = session.specs[step.campo];
      if (valor) {
        const label = step.pergunta.replace("?", "").replace(/\(.*\)/, "").trim();
        msg += `• ${label}: ${valor}\n`;
      }
    }
  }
  msg += `\nResponda SIM para confirmar ou NAO para cancelar.`;
  return msg;
}

// --- Servidor ---
async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ erro: "Use POST" }), { status: 405, headers: { "Content-Type": "application/json" } });
  }
  const { texto, usuario_id } = await req.json();
  if (!texto || !usuario_id) {
    return new Response(JSON.stringify({ erro: "Campos obrigatorios: texto, usuario_id" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  console.log(`\n[dealer-agent] usuario=${usuario_id} texto="${texto}"`);
  const result = processarMensagem(texto, usuario_id);
  console.log(`[dealer-agent] resposta="${result.resposta.substring(0, 100)}..."`);

  return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
}

console.log(`\n[FoodHub Dealer Agent V2] Teste local — MOCK MODE`);
console.log(`http://localhost:${PORT}`);
console.log(`\nFluxo frango sassami (8 steps + confirmacao):`);
console.log(`  1. "preciso de 10 ton de frango sassami em SP"  → inicia flow`);
console.log(`  2. "1" → corte: IQF`);
console.log(`  3. "1" → conservacao: congelado`);
console.log(`  4. "2" → embalagem individual: 1kg`);
console.log(`  5. "1" → embalagem master: caixa 10kg`);
console.log(`  6. "2" → frete: FOB (+ aviso prazo)`);
console.log(`  7. "5 dias uteis" → prazo expedicao`);
console.log(`  8. "28 dias boleto" → prazo pagamento`);
console.log(`  9. "3" → certificacao: sem exigencia`);
console.log(` 10. "sim" → confirma demanda\n`);

Deno.serve({ port: PORT }, handler);
