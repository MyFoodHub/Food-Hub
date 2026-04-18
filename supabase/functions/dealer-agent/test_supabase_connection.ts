/**
 * Teste rápido de conexão com Supabase.
 * Valida que a service_role_key funciona e lista tabelas acessíveis.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

console.log("[test] Conectando ao Supabase...");
console.log(`[test] URL: ${SUPABASE_URL}`);

// Testar leitura das tabelas principais
const tabelas = ["demandas", "propostas", "fornecedores", "profiles"];

for (const tabela of tabelas) {
  const { count, error } = await supabase
    .from(tabela)
    .select("*", { count: "exact", head: true });

  if (error) {
    console.log(`[test] ${tabela}: ERRO — ${error.message}`);
  } else {
    console.log(`[test] ${tabela}: OK — ${count} registros`);
  }
}

console.log("\n[test] Conexão validada.");
