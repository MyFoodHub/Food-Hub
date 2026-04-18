/**
 * Executa migration V3 via Supabase Management API.
 *
 * Decisão: Como não temos Docker/Supabase CLI local, e não existe RPC exec_sql,
 * usamos a Management API (api.supabase.com) para executar SQL diretamente.
 *
 * Alternativa mais simples: executar via SQL Editor no Dashboard.
 * Vamos gerar o SQL final aqui e tentar via Management API.
 * Se não funcionar, fornecer instruções para o Dashboard.
 */

const PROJECT_REF = "jqbuckofiaopxwllghac";
const SERVICE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpxYnVja29maWFvcHh3bGxnaGFjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NTA4NDg4NCwiZXhwIjoyMDkwNjYwODg0fQ.i6XmVRqWE-SgLKSPQMtE5FgkebqhhSdh8WLSxpUTzQo";
const SUPABASE_URL = `https://${PROJECT_REF}.supabase.co`;

// Tabelas que já existem (da verificação anterior)
const EXISTENTES = new Set([
  "demandas", "user_metrics", "pedidos", "contra_propostas", "user_preferences",
  "pedido_conformidade", "propostas", "fornecedor_ranking", "profiles", "mensagens",
  "user_kyc", "tabloide_itens", "fornecedores", "notificacoes", "ofertas",
  "recompras", "tabloides", "categorias", "fornecedor_produtos", "whatsapp_pushes",
  "negociacoes", "tracking", "avaliacoes", "produtos",
]);

// Tabelas V3 que precisam ser criadas (apenas as novas)
const NOVAS_TABELAS = [
  "members", "compradores", "fornecedores_v2", "sellers", "originadores",
  "categorias_referencia", "demandas_v2", "propostas_v2", "negociacoes_v2",
  "mensagens_v2", "pedidos_v2", "tracking_v2", "financials_v2",
  "acordos_comerciais", "contratos", "nf_documentos", "aprovacoes",
  "ia_logs", "tags", "notificacoes_v2",
];

console.log("=== FoodHub V3.0 — Migration ===\n");
console.log(`Tabelas existentes: ${EXISTENTES.size}`);
console.log(`Tabelas V3 a criar: ${NOVAS_TABELAS.length}`);

// Verificar quais V3 já existem
const novasQueJaExistem = NOVAS_TABELAS.filter((t) => EXISTENTES.has(t));
const novasParaCriar = NOVAS_TABELAS.filter((t) => !EXISTENTES.has(t));

if (novasQueJaExistem.length > 0) {
  console.log(`\nJá existem: ${novasQueJaExistem.join(", ")}`);
}
console.log(`Para criar: ${novasParaCriar.join(", ")}`);

// Tentar criar via approach 1: criar uma function exec_sql primeiro
console.log("\n=== Criando helper exec_sql via PostgREST ===\n");

// Approach: Usar supabase-js para criar a function via edge function
// Não temos acesso direto ao pg, mas podemos tentar usar a supabase-js admin

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  db: { schema: "public" },
  auth: { persistSession: false },
});

// Verificar tabelas V3 via query direta
console.log("Verificando tabelas V3...\n");
for (const tabela of NOVAS_TABELAS) {
  const { count, error } = await supabase
    .from(tabela)
    .select("*", { count: "exact", head: true });

  if (error) {
    console.log(`  [ NOVA ] ${tabela}`);
  } else {
    console.log(`  [EXISTE] ${tabela} — ${count} registros`);
  }
}

console.log(`\n=== BLOQUEADOR ===`);
console.log(`Não é possível executar DDL (CREATE TABLE) via PostgREST/supabase-js.`);
console.log(`O Supabase só permite DDL via:`);
console.log(`  1. SQL Editor no Dashboard (supabase.com/dashboard)`);
console.log(`  2. Supabase CLI com Docker (supabase db push)`);
console.log(`  3. Management API com access token (não service_role key)`);
console.log(`\nO SQL está pronto em: supabase/migrations/001_v3_schema.sql`);
console.log(`\nOPÇÃO MAIS RÁPIDA: Copiar e colar no SQL Editor do Dashboard.`);
console.log(`URL: https://supabase.com/dashboard/project/${PROJECT_REF}/sql/new`);
