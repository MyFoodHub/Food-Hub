/**
 * FoodHub V3 — Configuração compartilhada entre todos os agents.
 * Centraliza acesso ao Supabase e Claude API.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
export const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
export const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;

export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

export async function chamarClaude(prompt: string, system?: string): Promise<string> {
  const body: Record<string, unknown> = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  };
  if (system) body.system = system;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.content[0].text;
}

/** Gera código único para entidades (DEM-0001, PED-0001, etc) */
export async function gerarCodigo(prefixo: string, tabela: string): Promise<string> {
  const { count } = await supabase
    .from(tabela)
    .select("*", { count: "exact", head: true });
  const num = (count || 0) + 1;
  return `${prefixo}-${String(num).padStart(4, "0")}`;
}

/** Cria registro na tabela aprovacoes e notifica mesa */
export async function criarAprovacao(
  tipo: string,
  entidade_id: string,
  entidade_codigo: string
): Promise<void> {
  await supabase.from("aprovacoes").insert({
    tipo,
    entidade_id,
    entidade_codigo,
    status: "pendente",
    criado_em: new Date().toISOString(),
  });

  // Buscar membros da mesa para notificar
  const { data: mesa } = await supabase
    .from("members")
    .select("id")
    .eq("tipo", "mesa")
    .eq("status", "ativo");

  if (mesa?.length) {
    const notificacoes = mesa.map((m: { id: string }) => ({
      member_id: m.id,
      tipo: `aprovacao_${tipo}`,
      titulo: `Nova aprovação pendente: ${tipo}`,
      mensagem: `${tipo.toUpperCase()} ${entidade_codigo} aguarda sua aprovação.`,
      canal: "dashboard",
      acao_requerida: true,
      acao_tipo: "APROVAR",
      acao_codigo: entidade_codigo,
      criado_em: new Date().toISOString(),
    }));
    await supabase.from("notificacoes_v2").insert(notificacoes);
  }
}

/** Registra log de ação da IA */
export async function logIA(
  agente: string,
  member_id: string | null,
  canal: string,
  input: string,
  output: string,
  intencao: string,
  acao: string,
  sucesso: boolean,
  tempo_ms: number
): Promise<void> {
  await supabase.from("ia_logs").insert({
    agente,
    member_id,
    canal,
    input,
    output: output.substring(0, 2000),
    intencao,
    acao_tomada: acao,
    sucesso,
    tempo_resposta_ms: tempo_ms,
    criado_em: new Date().toISOString(),
  });
}

/** Headers CORS padrão */
export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

/** Response helper */
export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

export function corsResponse(): Response {
  return new Response("ok", { headers: CORS_HEADERS });
}
