import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  "https://jqbuckofiaopxwllghac.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpxYnVja29maWFvcHh3bGxnaGFjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NTA4NDg4NCwiZXhwIjoyMDkwNjYwODg0fQ.i6XmVRqWE-SgLKSPQMtE5FgkebqhhSdh8WLSxpUTzQo"
);

const tabelas = [
  // Existentes (V1)
  "demandas", "propostas", "fornecedores", "profiles", "mensagens", "produtos",
  // V3 novas
  "members", "compradores", "fornecedores_v2", "sellers", "originadores",
  "categorias_referencia", "demandas_v2", "propostas_v2", "negociacoes_v2",
  "mensagens_v2", "pedidos_v2", "tracking_v2", "financials_v2",
  "acordos_comerciais", "contratos", "nf_documentos", "aprovacoes",
  "ia_logs", "tags", "notificacoes_v2",
];

console.log("=== Verificação real de tabelas ===\n");

for (const t of tabelas) {
  // Tentar inserir e ler — se a tabela não existe, dá erro específico
  const { error } = await supabase.from(t).select("*").limit(1);
  if (error) {
    if (error.message.includes("not found") || error.message.includes("schema cache")) {
      console.log(`  [NAO EXISTE] ${t}`);
    } else {
      console.log(`  [ERRO]       ${t}: ${error.message.substring(0, 80)}`);
    }
  } else {
    console.log(`  [EXISTE]     ${t}`);
  }
}
