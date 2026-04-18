/**
 * FoodHub V3 — Migração do Pipeline Excel para Supabase
 *
 * Cria members (fornecedores, compradores, sellers, originadores)
 * e migra os 26 deals para as tabelas V3 corretas.
 *
 * Mapeamento:
 * - EM NEGOCIAÇÃO → negociacoes_v2 (em_andamento)
 * - PENDÊNCIA ATIVA → demandas_v2 (ativa)
 * - PROSPECÇÃO DE CLIENTES / PROSPECÇÃO DA INDÚSTRIA → demandas_v2 (rascunho)
 * - NEGÓCIO PARADO → demandas_v2 (ativa) + flag observação
 * - DEAL → pedidos_v2 (confirmado)
 */

const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  'https://jqbuckofiaopxwllghac.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpxYnVja29maWFvcHh3bGxnaGFjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NTA4NDg4NCwiZXhwIjoyMDkwNjYwODg0fQ.i6XmVRqWE-SgLKSPQMtE5FgkebqhhSdh8WLSxpUTzQo'
);

// --- Pipeline data (extraído do Excel) ---

const DEALS = [
  { num: 1, fornecedor: "Cardeal", regiao: "Venezuela", deal: "Venezuela · Salsicha + Calabresa — Trading Nasser", status: "NEGÓCIO PARADO", tipo: "Demanda de Mercado", potencial: 1600000, prazo: "Longo prazo", clientes: ["Trading Nasser (Venezuela)"], originador: "Aparecido Veiga (Cido)", seller: "Samuel Araújo", descricao: "Ministério Venezuelano liberou o permisso. Fornecimento via Trading Nasser.", pendencia: "Fornecedor precisa apresentar habilitação de exportação.", origem: null },
  { num: 2, fornecedor: "Cardeal", regiao: "Manaus", deal: "Manaus · Calabresa — DB", status: "PENDÊNCIA ATIVA", tipo: "Oferta da Indústria", potencial: 650000, prazo: "Médio prazo", clientes: ["DB Atacado (Manaus)"], originador: "Aparecido Veiga (Cido)", seller: "Samuel Araújo", descricao: "Oferta de calabresa para atacado DB em Manaus.", pendencia: "Gerar mesa de negociação com gerente de compras DB (Aureo).", origem: "Braço do Norte SC" },
  { num: 3, fornecedor: "Cardeal", regiao: "Acre", deal: "Acre · Calabresa — distribuidores", status: "PENDÊNCIA ATIVA", tipo: "Oferta da Indústria", potencial: 160000, prazo: "Médio prazo", clientes: ["Distribuidores Acre"], originador: "Aparecido Veiga (Cido)", seller: "Wilton Boca", descricao: "Oferta de calabresa para distribuidores no Acre.", pendencia: "Representante trazer propostas dos distribuidores locais." },
  { num: 4, fornecedor: "JA Alimentos", regiao: "Venezuela", deal: "Venezuela · Cortes bovinos — Trading Nasser", status: "EM NEGOCIAÇÃO", tipo: "Demanda de Mercado", potencial: 7700000, prazo: "Curto prazo", clientes: ["Trading Nasser (Venezuela)"], originador: "Aparecido Veiga (Cido)", seller: "Samuel Araújo", descricao: "Proposta formal recebida. Picanha USD13/kg, Contrafilé USD9,05/kg, Filé USD11,85/kg. FOB. 30% invoice / 70% estufamento." },
  { num: 5, fornecedor: "JA Alimentos", regiao: "UAE", deal: "UAE · Bovinos Halal — Massi | Foodstuff Trading", status: "PROSPECÇÃO DE CLIENTES", tipo: "Demanda de Mercado", potencial: 7700000, prazo: "Médio prazo", clientes: ["Massi Foodstuff (UAE)"], originador: "Aparecido Veiga (Cido)", seller: "FoodHub", descricao: "Reunião realizada. Aguardando specs e target price dos cortes Halal.", pendencia: "Aguardar especificações e target price do Massi." },
  { num: 6, fornecedor: "JA Alimentos", regiao: "Manaus", deal: "Manaus · Intermediação — DB, Nova Era, Big Amigão, Assaí", status: "PENDÊNCIA ATIVA", tipo: "Demanda de Mercado", potencial: 2500000, prazo: "Médio prazo", clientes: ["DB", "Nova Era", "Big Amigão", "Assaí"], originador: "Aparecido Veiga (Cido)", seller: "Samuel Araújo", descricao: "Central de compras regional de Manaus. Contas mapeadas.", pendencia: "Aguardar autorização da JA para intermediação via FoodHub." },
  { num: 7, fornecedor: "JA Alimentos", regiao: "Líbia", deal: "Líbia · Bovinos Halal — Trading Nasser", status: "PENDÊNCIA ATIVA", tipo: "Demanda de Mercado", potencial: 1000000, prazo: "Médio prazo", clientes: ["Trading Nasser (Líbia)"], originador: "Aparecido Veiga (Cido)", seller: "FoodHub", descricao: "Demanda específica da Líbia via Trading Nasser.", pendencia: "Aguardar specs e target price dos cortes Halal." },
  { num: 8, fornecedor: "Mais Suínos", regiao: "Manaus/Acre", deal: "Manaus & Acre · Suínos via representantes", status: "PROSPECÇÃO DE CLIENTES", tipo: "Oferta da Indústria", potencial: 120000, prazo: "Médio prazo", clientes: ["Atacadistas Manaus/Acre"], originador: "Aparecido Veiga (Cido)", seller: "Samuel Araújo", descricao: "Ofertas via representantes parceiros em todas as contas.", pendencia: "Representantes trazerem propostas das contas regionais." },
  { num: 9, fornecedor: "PMI", regiao: "UAE", deal: "UAE · Cordeiro — Massi | Foodstuff Trading", status: "PROSPECÇÃO DE CLIENTES", tipo: "Demanda de Mercado", potencial: 5000000, prazo: "Médio prazo", clientes: ["Massi Foodstuff (UAE)"], originador: "Aparecido Veiga (Cido)", seller: "FoodHub", descricao: "Reunião realizada. Potencial 3-5 containers/mês para países árabes.", pendencia: "Aguardar especificações via Massi." },
  { num: 10, fornecedor: "Panebras", regiao: "UAE", deal: "UAE · Pães congelados — Massi | Foodstuff Trading", status: "PROSPECÇÃO DE CLIENTES", tipo: "Oferta da Indústria", potencial: 500000, prazo: "Longo prazo", clientes: ["Massi Foodstuff (UAE)"], originador: "Aparecido Veiga (Cido)", seller: "FoodHub", descricao: "Reunião realizada. Massi avaliando mercado árabe.", pendencia: "Aguardar avaliação de mercado do Massi." },
  { num: 11, fornecedor: "Panebras", regiao: "São Paulo", deal: "Subway · Pães — Panebras", status: "PENDÊNCIA ATIVA", tipo: "Demanda de Mercado", potencial: 3000000, prazo: "Curto prazo", clientes: ["Zamp"], originador: "Aparecido Veiga (Cido)", seller: "FoodHub", descricao: "Cliente com perfil de contrato. NDA necessário para abertura de receitas.", pendencia: "Confirmar Panebras → reunião → NDA → abertura de receitas Subway." },
  { num: 12, fornecedor: "BB Distribuidora", regiao: "São Paulo", deal: "Subway · Frango empanado — BB Distribuidora", status: "PENDÊNCIA ATIVA", tipo: "Demanda de Mercado", potencial: 880000, prazo: "Médio prazo", clientes: ["Zamp"], originador: "Aparecido Veiga (Cido)", seller: "FoodHub", descricao: "40 ton/mês potencial. Specs pós-NDA.", pendencia: "Agendar reunião BB + Zamp. Abrir specs pós-NDA." },
  { num: 13, fornecedor: "BB Distribuidora", regiao: "São Paulo", deal: "Popeyes · Frango cubos — BB Distribuidora", status: "PENDÊNCIA ATIVA", tipo: "Demanda de Mercado", potencial: 1400000, prazo: "Médio prazo", clientes: ["Zamp"], originador: "Aparecido Veiga (Cido)", seller: "FoodHub", descricao: "90 ton/mês potencial. Cubos com pontas ajustadas. Linha dedicada necessária.", pendencia: "Agendar reunião. Avaliar linha dedicada para cubos." },
  { num: 14, fornecedor: "Seara", regiao: "São Paulo", deal: "LSG Catering · Retorno de exportação — Seara", status: "PROSPECÇÃO DE CLIENTES", tipo: "Oferta da Indústria", potencial: 300000, prazo: "Médio prazo", clientes: ["LSG Catering"], originador: "FoodHub", seller: "FoodHub", descricao: "FoodHub com representação direta da Seara para catering.", pendencia: "Avançar contato com Sócrates Campanher." },
  { num: 15, fornecedor: "Ataca Tudo", regiao: "São Paulo", deal: "Zamp · Pepsi em lata — Ataca Tudo", status: "DEAL", tipo: "Demanda de Mercado", potencial: 1800000, prazo: "Curto prazo", clientes: ["Zamp"], originador: "FoodHub", seller: "FoodHub", descricao: "14 trucks de guaraná e Pepsi em lata", pendencia: "Acompanhar entregas" },
  { num: 16, fornecedor: "Frango Bello", regiao: "São Paulo", deal: "Redes Fast Food · Frango e Hambúrguer — Frango Bello", status: "PROSPECÇÃO DA INDÚSTRIA", tipo: "Demanda de Mercado", potencial: 3000000, prazo: "Médio prazo", clientes: ["Habibs", "Giraffas", "Bobs", "Zamp", "Dominos", "Grupo Trigo"], originador: "José Noujaim", seller: "FoodHub", descricao: "Indústria ainda não no portfólio. Oportunidade identificada por José Noujaim.", pendencia: "Integrar Frango Bello ao portfólio FoodHub antes de abordar clientes." },
  { num: 17, fornecedor: "CampCarne", regiao: "São Paulo", deal: "Redes Fast Food · Frango e Hambúrguer — CampCarne", status: "PROSPECÇÃO DE CLIENTES", tipo: "Demanda de Mercado", potencial: 2000000, prazo: "Médio prazo", clientes: ["Grupo Trigo", "Zamp", "Dominos", "Habibs"], originador: "FoodHub", seller: "FoodHub", descricao: "Indústria validada. Em desenvolvimento de clientes nas redes.", pendencia: "Apresentar portfólio CampCarne para compras das redes." },
  { num: 18, fornecedor: "Pract Foods", regiao: "Norte/Nordeste", deal: "Norte/Nordeste · Expansão — Pract Foods", status: "PROSPECÇÃO DE CLIENTES", tipo: "Demanda de Mercado", potencial: 1000000, prazo: "Médio prazo", clientes: ["Atacadistas Norte/Nordeste"], originador: "Alex Brasil", seller: "FoodHub", descricao: "Indústria no portfólio. Expansão via atacadistas nas regiões FoodHub.", pendencia: "Mapear atacadistas nas regiões de cobertura FoodHub." },
  { num: 19, fornecedor: "Itabom", regiao: "Norte/Nordeste", deal: "Norte/Nordeste · Expansão — Itabom", status: "PROSPECÇÃO DE CLIENTES", tipo: "Demanda de Mercado", potencial: 1000000, prazo: "Médio prazo", clientes: ["Atacadistas Norte/Nordeste"], originador: "Alex Brasil", seller: "FoodHub", descricao: "Indústria no portfólio. Expansão via atacadistas nas regiões FoodHub.", pendencia: "Mapear atacadistas nas regiões de cobertura FoodHub." },
  { num: 20, fornecedor: "Golden Foods", regiao: "Norte", deal: "Norte · Batata Frita — Golden Foods", status: "PROSPECÇÃO DA INDÚSTRIA", tipo: "Demanda de Mercado", potencial: 3000000, prazo: "Longo prazo", clientes: ["Atacadistas Norte BR"], originador: "FoodHub", seller: "FoodHub", descricao: "Oportunidade identificada. Indústria ainda em prospecção para portfólio.", pendencia: "Prospectar Golden Foods para entrada no portfólio FoodHub." },
  { num: 21, fornecedor: "Grupo Gennius", regiao: "São Paulo", deal: "Subway · Cookies — Grupo Gennius", status: "PROSPECÇÃO DE CLIENTES", tipo: "Demanda de Mercado", potencial: 2000000, prazo: "Curto prazo", clientes: ["Zamp"], originador: "Aparecido Veiga (Cido)", seller: "FoodHub", descricao: "Demanda originada pelo cliente Subway via Grupo Gennius.", pendencia: "Conectar Gennius com compras da Zamp. Validar specs e volume." },
  { num: 22, fornecedor: "Grupo Gennius", regiao: "São Paulo", deal: "Seara · Produção de Pizza — Grupo Gennius", status: "PROSPECÇÃO DE CLIENTES", tipo: "Oferta da Indústria", potencial: 5000000, prazo: "Longo prazo", clientes: ["Seara (P&D)"], originador: "Aparecido Veiga (Cido)", seller: "FoodHub", descricao: "Cliente Seara P&D demanda produção de pizza via Grupo Gennius.", pendencia: "Promover reunião Gennius × Seara P&D → NDA → specs." },
  { num: 23, fornecedor: "A definir", regiao: "São Paulo", deal: "Zamp · Fornecimento de Óleo", status: "PROSPECÇÃO DA INDÚSTRIA", tipo: "Demanda de Mercado", potencial: 200000, prazo: "Médio prazo", clientes: ["Zamp"], originador: "Aparecido Veiga (Cido)", seller: "FoodHub", descricao: "Demanda de fornecimento de óleo para a Zamp.", pendencia: "Identificar e desenvolver indústria fornecedora de óleo para a Zamp." },
  { num: 24, fornecedor: "Delly's", regiao: "Brasil", deal: "Bob's em casa", status: "PROSPECÇÃO DE CLIENTES", tipo: "Demanda de Mercado", potencial: 500000, prazo: "Médio prazo", clientes: ["Distribuição nacional"], originador: "FoodHub", seller: "FoodHub", descricao: null },
  { num: 25, fornecedor: "Pract Foods", regiao: "Acre", deal: "Parceria com o Boca · Expansão — Pract Foods", status: "PROSPECÇÃO DE CLIENTES", tipo: "Demanda de Mercado", potencial: 750000, prazo: "Curto prazo", clientes: ["Atacadistas Acre"], originador: "Alex Brasil", seller: "Boca", descricao: "Indústria no portfólio. Expansão via atacadistas nas regiões FoodHub.", pendencia: "Envio de amostras e negociação com clientes" },
  { num: 26, fornecedor: "Lar", regiao: "São Paulo", deal: "Lar - retalho de peito 60 ton mês", status: "PROSPECÇÃO DE CLIENTES", tipo: "Demanda de Mercado", potencial: 510000, prazo: "Curto prazo", clientes: ["Habibs"], originador: "Alex Brasil", seller: "FoodHub", descricao: "Enviar amostra", pendencia: "Preço Target e Spec atendem" },
];

// --- Caches para dedup ---
const memberCache = {}; // nome → id

async function getOrCreateMember(nome, tipo) {
  const key = `${nome}__${tipo}`;
  if (memberCache[key]) return memberCache[key];

  // Check existing
  const { data: existing } = await sb.from('members')
    .select('id')
    .eq('nome', nome)
    .eq('tipo', tipo)
    .limit(1)
    .single();

  if (existing) {
    memberCache[key] = existing.id;
    return existing.id;
  }

  // Create
  const { data, error } = await sb.from('members').insert({
    nome,
    tipo,
    status: 'ativo',
    criado_em: new Date().toISOString(),
    atualizado_em: new Date().toISOString(),
  }).select('id').single();

  if (error) {
    console.error(`  [ERRO] Criar member ${nome} (${tipo}):`, error.message);
    return null;
  }

  memberCache[key] = data.id;
  return data.id;
}

async function run() {
  console.log('=== FoodHub V3 — Migração Pipeline ===\n');

  // 1. Criar member FoodHub Mesa
  const mesaId = await getOrCreateMember('FoodHub Mesa', 'mesa');
  console.log(`[OK] Mesa FoodHub: ${mesaId}`);

  // 2. Extrair e criar todos os members únicos
  const fornecedoresUnicos = [...new Set(DEALS.map(d => d.fornecedor).filter(f => f !== 'A definir'))];
  const clientesUnicos = [...new Set(DEALS.flatMap(d => d.clientes))];
  const sellerNomes = [...new Set(DEALS.map(d => d.seller).filter(s => s !== 'FoodHub'))];
  const originadorNomes = [...new Set(DEALS.map(d => d.originador).filter(o => o !== 'FoodHub'))];

  console.log(`\nFornecedores: ${fornecedoresUnicos.length}`);
  for (const f of fornecedoresUnicos) {
    const id = await getOrCreateMember(f, 'fornecedor');
    console.log(`  [OK] ${f}: ${id}`);
  }

  console.log(`\nCompradores: ${clientesUnicos.length}`);
  for (const c of clientesUnicos) {
    const id = await getOrCreateMember(c, 'comprador');
    console.log(`  [OK] ${c}: ${id}`);
  }

  console.log(`\nSellers: ${sellerNomes.length}`);
  for (const s of sellerNomes) {
    const id = await getOrCreateMember(s, 'seller');
    console.log(`  [OK] ${s}: ${id}`);
  }

  console.log(`\nOriginadores: ${originadorNomes.length}`);
  for (const o of originadorNomes) {
    const id = await getOrCreateMember(o, 'originador');
    console.log(`  [OK] ${o}: ${id}`);
  }

  // 3. Migrar deals
  console.log(`\n=== Migrando ${DEALS.length} deals ===\n`);

  let demandas = 0, negociacoes = 0, pedidos = 0, aprovacoes = 0;
  let valorTotal = 0;

  for (const deal of DEALS) {
    const codigo = `PIP-${String(deal.num).padStart(4, '0')}`;
    const fornecedorId = deal.fornecedor !== 'A definir'
      ? await getOrCreateMember(deal.fornecedor, 'fornecedor')
      : null;
    const compradorId = await getOrCreateMember(deal.clientes[0], 'comprador');
    const sellerId = deal.seller !== 'FoodHub'
      ? await getOrCreateMember(deal.seller, 'seller')
      : mesaId;
    const originadorId = deal.originador !== 'FoodHub'
      ? await getOrCreateMember(deal.originador, 'originador')
      : mesaId;

    valorTotal += deal.potencial;

    if (deal.status === 'DEAL') {
      // → pedidos_v2 confirmado
      const { data, error } = await sb.from('pedidos_v2').insert({
        codigo,
        fornecedor_id: fornecedorId,
        comprador_id: compradorId,
        produto_nome: deal.deal,
        especificacao: { descricao: deal.descricao, pendencia: deal.pendencia, tipo: deal.tipo, potencial_mensal: deal.potencial, prazo: deal.prazo, regiao: deal.regiao, origem: deal.origem, clientes: deal.clientes, originador: deal.originador, seller: deal.seller },
        total: deal.potencial,
        status: 'confirmado',
        criado_em: new Date().toISOString(),
      }).select('id').single();

      if (error) { console.error(`  [ERRO] Deal #${deal.num}: ${error.message}`); continue; }
      console.log(`  [PEDIDO]     #${deal.num} ${deal.deal} → R$${(deal.potencial/1000000).toFixed(1)}M`);
      pedidos++;

      // Aprovação
      await sb.from('aprovacoes').insert({ tipo: 'pedido', entidade_id: data.id, entidade_codigo: codigo, status: 'pendente', criado_em: new Date().toISOString() });
      aprovacoes++;

    } else if (deal.status === 'EM NEGOCIAÇÃO') {
      // Criar demanda + negociação
      const { data: dem } = await sb.from('demandas_v2').insert({
        codigo,
        comprador_id: compradorId,
        produto_nome: deal.deal,
        especificacao: { descricao: deal.descricao, pendencia: deal.pendencia, tipo: deal.tipo, potencial_mensal: deal.potencial, prazo: deal.prazo, regiao: deal.regiao, origem: deal.origem, clientes: deal.clientes, originador: deal.originador, seller: deal.seller },
        regiao: deal.regiao,
        preco_alvo: deal.potencial,
        status: 'ativa',
        canal: 'pipeline_excel',
        criado_em: new Date().toISOString(),
      }).select('id').single();

      if (!dem) { console.error(`  [ERRO] Demanda #${deal.num}`); continue; }
      demandas++;

      const { data: neg, error: negErr } = await sb.from('negociacoes_v2').insert({
        demanda_id: dem.id,
        comprador_id: compradorId,
        fornecedor_id: fornecedorId,
        preco_atual: deal.potencial,
        status: 'em_andamento',
        criado_em: new Date().toISOString(),
      }).select('id').single();

      if (negErr) { console.error(`  [ERRO] Negociação #${deal.num}: ${negErr.message}`); continue; }
      negociacoes++;
      console.log(`  [NEGOCIAÇÃO] #${deal.num} ${deal.deal} → R$${(deal.potencial/1000000).toFixed(1)}M`);

      await sb.from('aprovacoes').insert({ tipo: 'deal', entidade_id: neg.id, entidade_codigo: codigo, status: 'pendente', criado_em: new Date().toISOString() });
      aprovacoes++;

    } else {
      // PENDÊNCIA ATIVA, PROSPECÇÃO, NEGÓCIO PARADO → demandas_v2
      let statusDemanda = 'rascunho';
      if (deal.status === 'PENDÊNCIA ATIVA') statusDemanda = 'ativa';
      if (deal.status === 'NEGÓCIO PARADO') statusDemanda = 'ativa'; // ativa mas com flag

      const { data, error } = await sb.from('demandas_v2').insert({
        codigo,
        comprador_id: compradorId,
        produto_nome: deal.deal,
        especificacao: { descricao: deal.descricao, pendencia: deal.pendencia, tipo: deal.tipo, potencial_mensal: deal.potencial, prazo: deal.prazo, regiao: deal.regiao, origem: deal.origem, clientes: deal.clientes, originador: deal.originador, seller: deal.seller, status_original: deal.status },
        regiao: deal.regiao,
        preco_alvo: deal.potencial,
        status: statusDemanda,
        canal: 'pipeline_excel',
        criado_em: new Date().toISOString(),
      }).select('id').single();

      if (error) { console.error(`  [ERRO] Deal #${deal.num}: ${error.message}`); continue; }

      const label = deal.status === 'PENDÊNCIA ATIVA' ? 'PENDÊNCIA' : deal.status === 'NEGÓCIO PARADO' ? 'PARADO   ' : 'PROSPECÇÃO';
      console.log(`  [${label}]  #${deal.num} ${deal.deal} → R$${(deal.potencial/1000000).toFixed(1)}M`);
      demandas++;

      await sb.from('aprovacoes').insert({ tipo: 'demanda', entidade_id: data.id, entidade_codigo: codigo, status: 'pendente', criado_em: new Date().toISOString() });
      aprovacoes++;
    }
  }

  // 4. Seed categorias
  console.log('\n=== Seed categorias_referencia ===\n');
  const categorias = [
    { categoria: 'frango', subcategorias_comuns: ['sassami','file_peito','coxa_sobrecoxa','asa','inteiro','desossado','empanado','cubos','retalho'], tags_comuns: ['proteina','ave','IQF','congelado','resfriado','GFSI','FSSC'] },
    { categoria: 'suino', subcategorias_comuns: ['calabresa','salsicha','linguica','presunto','bacon','pernil'], tags_comuns: ['proteina','processado','defumado','embutido'] },
    { categoria: 'bovino', subcategorias_comuns: ['alcatra','contrafile','patinho','acem','coxao','fraldinha','picanha','file','dianteiro','traseiro'], tags_comuns: ['proteina','bovino','resfriado','congelado','SIF','halal'] },
    { categoria: 'laticinios', subcategorias_comuns: ['mucarela','queijo','manteiga','creme_leite'], tags_comuns: ['laticinios','SIF'] },
    { categoria: 'ovos', subcategorias_comuns: ['branco','vermelho','caipira','codorna'], tags_comuns: ['ovos','bandeja','caixa'] },
    { categoria: 'graos', subcategorias_comuns: ['oleo_soja','farinha_trigo','arroz','feijao','milho'], tags_comuns: ['graos','commodities','saco'] },
    { categoria: 'pescado', subcategorias_comuns: ['tilapia','salmon','sardinha','atum','camarao'], tags_comuns: ['pescado','congelado','resfriado'] },
    { categoria: 'batata', subcategorias_comuns: ['congelada','chips','palito','ondulada'], tags_comuns: ['batata','congelado','IQF'] },
    { categoria: 'panificacao', subcategorias_comuns: ['pao','cookie','pizza','massa_congelada'], tags_comuns: ['panificacao','congelado','NDA'] },
    { categoria: 'bebidas', subcategorias_comuns: ['refrigerante','suco','agua','cerveja','energetico'], tags_comuns: ['bebidas','lata','PET','distribuicao'] },
    { categoria: 'cordeiro', subcategorias_comuns: ['inteiro','cortes','halal'], tags_comuns: ['proteina','ovino','halal','exportacao'] },
    { categoria: 'outros', subcategorias_comuns: [], tags_comuns: [] },
  ];

  for (const cat of categorias) {
    const { error } = await sb.from('categorias_referencia').upsert(cat, { onConflict: 'categoria' });
    console.log(error ? `  [ERRO] ${cat.categoria}: ${error.message}` : `  [OK] ${cat.categoria}`);
  }

  // 5. Resumo
  const { count: totalMembers } = await sb.from('members').select('*', { count: 'exact', head: true });
  const { count: totalDemandas } = await sb.from('demandas_v2').select('*', { count: 'exact', head: true });
  const { count: totalNeg } = await sb.from('negociacoes_v2').select('*', { count: 'exact', head: true });
  const { count: totalPed } = await sb.from('pedidos_v2').select('*', { count: 'exact', head: true });
  const { count: totalAprov } = await sb.from('aprovacoes').select('*', { count: 'exact', head: true });
  const { count: totalCat } = await sb.from('categorias_referencia').select('*', { count: 'exact', head: true });

  console.log('\n========================================');
  console.log('  MIGRAÇÃO CONCLUÍDA');
  console.log('========================================');
  console.log(`  Members criados:      ${totalMembers}`);
  console.log(`  Demandas migradas:    ${totalDemandas}`);
  console.log(`  Negociações criadas:  ${totalNeg}`);
  console.log(`  Pedidos criados:      ${totalPed}`);
  console.log(`  Aprovações pendentes: ${totalAprov}`);
  console.log(`  Categorias seed:      ${totalCat}`);
  console.log(`  Valor total pipeline: R$ ${(valorTotal/1000000).toFixed(1)}M/mês`);
  console.log('========================================\n');
}

run().catch(err => console.error('FATAL:', err));
