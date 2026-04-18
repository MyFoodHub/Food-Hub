/**
 * FoodHub V3 — Fase 2: Seed de categorias referência
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  "https://jqbuckofiaopxwllghac.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpxYnVja29maWFvcHh3bGxnaGFjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NTA4NDg4NCwiZXhwIjoyMDkwNjYwODg0fQ.i6XmVRqWE-SgLKSPQMtE5FgkebqhhSdh8WLSxpUTzQo"
);

const categorias = [
  { categoria: "frango", subcategorias_comuns: ["sassami","file_peito","coxa_sobrecoxa","asa","inteiro","desossado"], tags_comuns: ["proteina","ave","IQF","congelado","resfriado","GFSI","FSSC"] },
  { categoria: "suino", subcategorias_comuns: ["calabresa","salsicha","linguica","presunto","bacon","pernil"], tags_comuns: ["proteina","processado","defumado","embutido"] },
  { categoria: "bovino", subcategorias_comuns: ["alcatra","contrafile","patinho","acem","coxao","fraldinha"], tags_comuns: ["proteina","bovino","resfriado","congelado","SIF"] },
  { categoria: "laticinios", subcategorias_comuns: ["mucarela","queijo","manteiga","creme_leite"], tags_comuns: ["laticinios","SIF"] },
  { categoria: "ovos", subcategorias_comuns: ["branco","vermelho","caipira","codorna"], tags_comuns: ["ovos","bandeja","caixa"] },
  { categoria: "graos", subcategorias_comuns: ["oleo_soja","farinha_trigo","arroz","feijao","milho"], tags_comuns: ["graos","commodities","saco"] },
  { categoria: "pescado", subcategorias_comuns: ["tilapia","salmon","sardinha","atum","camarao"], tags_comuns: ["pescado","congelado","resfriado"] },
  { categoria: "batata", subcategorias_comuns: ["congelada","chips","palito","ondulada"], tags_comuns: ["batata","congelado","IQF"] },
  { categoria: "outros", subcategorias_comuns: [], tags_comuns: [] },
];

console.log("=== Fase 2: Seed de Categorias ===\n");

// Verificar se já tem dados
const { count } = await supabase.from("categorias_referencia").select("*", { count: "exact", head: true });
console.log(`Categorias existentes: ${count || 0}`);

if (count && count > 0) {
  console.log("Categorias já populadas. Pulando seed.\n");
} else {
  for (const cat of categorias) {
    const { error } = await supabase.from("categorias_referencia").insert(cat);
    if (error) {
      if (error.message?.includes("duplicate") || error.code === "23505") {
        console.log(`  [==] ${cat.categoria} (já existe)`);
      } else {
        console.log(`  [!!] ${cat.categoria}: ${error.message}`);
      }
    } else {
      console.log(`  [OK] ${cat.categoria}`);
    }
  }
}

// Verificar resultado
const { data, count: total } = await supabase.from("categorias_referencia").select("categoria", { count: "exact" });
console.log(`\nTotal de categorias: ${total}`);
data?.forEach((c: { categoria: string }) => console.log(`  • ${c.categoria}`));

console.log("\nFase 2 completa.");
