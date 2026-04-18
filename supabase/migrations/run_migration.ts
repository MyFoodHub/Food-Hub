/**
 * Executa a migration V3 no Supabase.
 * Cada CREATE TABLE é executado individualmente via SQL API.
 */

const SUPABASE_URL = "https://jqbuckofiaopxwllghac.supabase.co";
const SERVICE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpxYnVja29maWFvcHh3bGxnaGFjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NTA4NDg4NCwiZXhwIjoyMDkwNjYwODg0fQ.i6XmVRqWE-SgLKSPQMtE5FgkebqhhSdh8WLSxpUTzQo";

async function executarSQL(label: string, sql: string): Promise<boolean> {
  // Tentar via Supabase Management API (pg-meta)
  const endpoints = [
    `${SUPABASE_URL}/rest/v1/rpc/exec_sql`,
    `${SUPABASE_URL}/pg/query`,
  ];

  for (const endpoint of endpoints) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": SERVICE_KEY,
          "Authorization": `Bearer ${SERVICE_KEY}`,
          "Prefer": "return=minimal",
        },
        body: JSON.stringify(
          endpoint.includes("rpc") ? { sql } : { query: sql }
        ),
      });

      const text = await res.text();

      if (res.ok) {
        console.log(`[OK] ${label}`);
        return true;
      }

      if (text.includes("already exists")) {
        console.log(`[==] ${label} (já existe)`);
        return true;
      }

      if (res.status === 404) continue; // Tentar próximo endpoint

      console.log(`[!!] ${label}: ${res.status} — ${text.substring(0, 150)}`);
      return false;
    } catch (e) {
      continue;
    }
  }

  console.log(`[??] ${label}: nenhum endpoint SQL disponível`);
  return false;
}

// Primeiro, verificar quais tabelas já existem
console.log("=== Verificando tabelas existentes ===\n");

const checkRes = await fetch(
  `${SUPABASE_URL}/rest/v1/?apikey=${SERVICE_KEY}`,
  {
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
    },
  }
);

if (checkRes.ok) {
  const schemas = await checkRes.json();
  // O endpoint raiz retorna info sobre tabelas disponíveis
  console.log("Resposta do endpoint raiz:", JSON.stringify(schemas).substring(0, 500));
} else {
  console.log("Status check:", checkRes.status);
}

// Listar tabelas via PostgREST introspection
console.log("\n=== Verificando tabelas via OpenAPI ===\n");

const openApiRes = await fetch(`${SUPABASE_URL}/rest/v1/`, {
  headers: {
    "apikey": SERVICE_KEY,
    "Authorization": `Bearer ${SERVICE_KEY}`,
    "Accept": "application/openapi+json",
  },
});

if (openApiRes.ok) {
  const openApi = await openApiRes.json();
  const tabelas = Object.keys(openApi.definitions || openApi.paths || {});
  console.log(`Tabelas encontradas (${tabelas.length}):`);
  tabelas.forEach((t) => console.log(`  • ${t}`));
} else {
  // Tentar listar via query simples
  const tables = ["members", "compradores", "fornecedores_v2", "sellers", "originadores",
    "categorias_referencia", "produtos", "demandas_v2", "propostas_v2", "negociacoes_v2",
    "mensagens_v2", "pedidos_v2", "tracking_v2", "financials_v2", "acordos_comerciais",
    "contratos", "nf_documentos", "aprovacoes", "ia_logs", "tags", "notificacoes_v2"];

  console.log("Verificando tabelas individualmente...\n");
  for (const t of tables) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${t}?select=count&limit=0`, {
      headers: {
        "apikey": SERVICE_KEY,
        "Authorization": `Bearer ${SERVICE_KEY}`,
        "Prefer": "count=exact",
      },
    });
    if (r.ok) {
      const count = r.headers.get("content-range");
      console.log(`  [existe] ${t} — ${count}`);
    } else {
      console.log(`  [  ---  ] ${t} — não existe`);
    }
  }
}

console.log("\n=== Tentando criar tabelas via exec_sql RPC ===\n");

// Verificar se exec_sql function existe
const rpcCheck = await fetch(`${SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "apikey": SERVICE_KEY,
    "Authorization": `Bearer ${SERVICE_KEY}`,
  },
  body: JSON.stringify({ sql: "SELECT 1 as test" }),
});
console.log(`exec_sql RPC: ${rpcCheck.status}`);
const rpcText = await rpcCheck.text();
console.log(`Resposta: ${rpcText.substring(0, 200)}`);
