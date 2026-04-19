/**
 * FoodHub — Migrate pipeline data to V3 final tables
 * members → players, demandas_v2 → oportunidades, Pipeline Excel → deals
 */
var { createClient } = require('@supabase/supabase-js');
var sb = createClient('https://jqbuckofiaopxwllghac.supabase.co', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpxYnVja29maWFvcHh3bGxnaGFjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NTA4NDg4NCwiZXhwIjoyMDkwNjYwODg0fQ.i6XmVRqWE-SgLKSPQMtE5FgkebqhhSdh8WLSxpUTzQo', {auth:{persistSession:false}});

var playerCache = {};

async function getOrCreatePlayer(razaoSocial, tipo) {
  var key = razaoSocial + '__' + tipo;
  if (playerCache[key]) return playerCache[key];

  var { data: existing } = await sb.from('players').select('id').eq('razao_social', razaoSocial).limit(1).single();
  if (existing) {
    playerCache[key] = existing.id;
    return existing.id;
  }

  var { data, error } = await sb.from('players').insert({
    razao_social: razaoSocial,
    tipo: [tipo],
    status: 'ativo',
    criado_em: new Date().toISOString()
  }).select('id').single();

  if (error) { console.log('  [ERR] Player ' + razaoSocial + ': ' + error.message); return null; }
  playerCache[key] = data.id;
  return data.id;
}

var DEALS = [
  { num:1, fornecedor:"Cardeal", deal:"Venezuela · Salsicha + Calabresa", status:"parado", potencial:1600000, clientes:["Trading Nasser (Venezuela)"], originador:"Aparecido Veiga (Cido)", seller:"Samuel Araujo", regiao:"Venezuela", descricao:"Ministerio Venezuelano liberou. Fornecimento via Trading Nasser." },
  { num:2, fornecedor:"Cardeal", deal:"Manaus · Calabresa — DB", status:"ativa", potencial:650000, clientes:["DB Atacado (Manaus)"], originador:"Aparecido Veiga (Cido)", seller:"Samuel Araujo", regiao:"Manaus", descricao:"Oferta de calabresa para atacado DB em Manaus." },
  { num:3, fornecedor:"Cardeal", deal:"Acre · Calabresa — distribuidores", status:"ativa", potencial:160000, clientes:["Distribuidores Acre"], originador:"Aparecido Veiga (Cido)", seller:"Wilton Boca", regiao:"Acre", descricao:"Oferta de calabresa para distribuidores no Acre." },
  { num:4, fornecedor:"JA Alimentos", deal:"Venezuela · Cortes bovinos", status:"em_andamento", potencial:7700000, clientes:["Trading Nasser (Venezuela)"], originador:"Aparecido Veiga (Cido)", seller:"Samuel Araujo", regiao:"Venezuela", descricao:"Proposta formal recebida. Picanha USD13/kg, Contrafil USD9,05/kg." },
  { num:5, fornecedor:"JA Alimentos", deal:"UAE · Bovinos Halal", status:"rascunho", potencial:7700000, clientes:["Massi Foodstuff (UAE)"], originador:"Aparecido Veiga (Cido)", seller:"FoodHub", regiao:"UAE", descricao:"Reuniao realizada. Aguardando specs e target price." },
  { num:6, fornecedor:"JA Alimentos", deal:"Manaus · Intermediacao", status:"ativa", potencial:2500000, clientes:["DB","Nova Era","Big Amigao","Assai"], originador:"Aparecido Veiga (Cido)", seller:"Samuel Araujo", regiao:"Manaus", descricao:"Central de compras regional de Manaus." },
  { num:7, fornecedor:"JA Alimentos", deal:"Libia · Bovinos Halal", status:"ativa", potencial:1000000, clientes:["Trading Nasser (Libia)"], originador:"Aparecido Veiga (Cido)", seller:"FoodHub", regiao:"Libia", descricao:"Demanda especifica da Libia via Trading Nasser." },
  { num:8, fornecedor:"Mais Suinos", deal:"Manaus & Acre · Suinos", status:"rascunho", potencial:120000, clientes:["Atacadistas Manaus/Acre"], originador:"Aparecido Veiga (Cido)", seller:"Samuel Araujo", regiao:"Manaus/Acre", descricao:"Ofertas via representantes parceiros." },
  { num:9, fornecedor:"PMI", deal:"UAE · Cordeiro", status:"rascunho", potencial:5000000, clientes:["Massi Foodstuff (UAE)"], originador:"Aparecido Veiga (Cido)", seller:"FoodHub", regiao:"UAE", descricao:"Potencial 3-5 containers/mes para paises arabes." },
  { num:10, fornecedor:"Panebras", deal:"UAE · Paes congelados", status:"rascunho", potencial:500000, clientes:["Massi Foodstuff (UAE)"], originador:"Aparecido Veiga (Cido)", seller:"FoodHub", regiao:"UAE", descricao:"Massi avaliando mercado arabe." },
  { num:11, fornecedor:"Panebras", deal:"Subway · Paes", status:"ativa", potencial:3000000, clientes:["Zamp"], originador:"Aparecido Veiga (Cido)", seller:"FoodHub", regiao:"Sao Paulo", descricao:"NDA necessario para abertura de receitas." },
  { num:12, fornecedor:"BB Distribuidora", deal:"Subway · Frango empanado", status:"ativa", potencial:880000, clientes:["Zamp"], originador:"Aparecido Veiga (Cido)", seller:"FoodHub", regiao:"Sao Paulo", descricao:"40 ton/mes potencial." },
  { num:13, fornecedor:"BB Distribuidora", deal:"Popeyes · Frango cubos", status:"ativa", potencial:1400000, clientes:["Zamp"], originador:"Aparecido Veiga (Cido)", seller:"FoodHub", regiao:"Sao Paulo", descricao:"90 ton/mes potencial. Linha dedicada necessaria." },
  { num:14, fornecedor:"Seara", deal:"LSG Catering · Retorno exportacao", status:"rascunho", potencial:300000, clientes:["LSG Catering"], originador:"FoodHub", seller:"FoodHub", regiao:"Sao Paulo", descricao:"FoodHub com representacao direta da Seara." },
  { num:15, fornecedor:"Ataca Tudo", deal:"Zamp · Pepsi em lata", status:"fechado", potencial:1800000, clientes:["Zamp"], originador:"FoodHub", seller:"FoodHub", regiao:"Sao Paulo", descricao:"14 trucks de guarana e Pepsi em lata." },
  { num:16, fornecedor:"Frango Bello", deal:"Redes Fast Food · Frango", status:"rascunho", potencial:3000000, clientes:["Habibs","Zamp","Dominos"], originador:"Jose Noujaim", seller:"FoodHub", regiao:"Sao Paulo", descricao:"Industria ainda nao no portfolio." },
  { num:17, fornecedor:"CampCarne", deal:"Redes Fast Food · Frango", status:"rascunho", potencial:2000000, clientes:["Grupo Trigo","Zamp"], originador:"FoodHub", seller:"FoodHub", regiao:"Sao Paulo", descricao:"Industria validada." },
  { num:18, fornecedor:"Pract Foods", deal:"Norte/Nordeste · Expansao", status:"rascunho", potencial:1000000, clientes:["Atacadistas Norte/Nordeste"], originador:"Alex Brasil", seller:"FoodHub", regiao:"Norte/Nordeste", descricao:"Expansao via atacadistas." },
  { num:19, fornecedor:"Itabom", deal:"Norte/Nordeste · Expansao", status:"rascunho", potencial:1000000, clientes:["Atacadistas Norte/Nordeste"], originador:"Alex Brasil", seller:"FoodHub", regiao:"Norte/Nordeste", descricao:"Expansao via atacadistas." },
  { num:20, fornecedor:"Golden Foods", deal:"Norte · Batata Frita", status:"rascunho", potencial:3000000, clientes:["Atacadistas Norte BR"], originador:"FoodHub", seller:"FoodHub", regiao:"Norte", descricao:"Industria em prospeccao." },
  { num:21, fornecedor:"Grupo Gennius", deal:"Subway · Cookies", status:"rascunho", potencial:2000000, clientes:["Zamp"], originador:"Aparecido Veiga (Cido)", seller:"FoodHub", regiao:"Sao Paulo", descricao:"Validar specs e volume." },
  { num:22, fornecedor:"Grupo Gennius", deal:"Seara · Pizza", status:"rascunho", potencial:5000000, clientes:["Seara (P&D)"], originador:"Aparecido Veiga (Cido)", seller:"FoodHub", regiao:"Sao Paulo", descricao:"Reuniao Gennius x Seara P&D." },
  { num:23, fornecedor:"A definir", deal:"Zamp · Oleo", status:"rascunho", potencial:200000, clientes:["Zamp"], originador:"Aparecido Veiga (Cido)", seller:"FoodHub", regiao:"Sao Paulo", descricao:"Industria a ser identificada." },
  { num:24, fornecedor:"Delly's", deal:"Bob's em casa", status:"rascunho", potencial:500000, clientes:["Distribuicao nacional"], originador:"FoodHub", seller:"FoodHub", regiao:"Brasil", descricao:"" },
  { num:25, fornecedor:"Pract Foods", deal:"Parceria Boca · Acre", status:"rascunho", potencial:750000, clientes:["Atacadistas Acre"], originador:"Alex Brasil", seller:"Boca", regiao:"Acre", descricao:"Envio de amostras." },
  { num:26, fornecedor:"Lar", deal:"Retalho de peito 60 ton", status:"rascunho", potencial:510000, clientes:["Habibs"], originador:"Alex Brasil", seller:"FoodHub", regiao:"Sao Paulo", descricao:"Enviar amostra. Preco Target atende." },
];

async function run() {
  console.log('=== Migracao Pipeline → V3 Final ===\n');

  // Get FoodHub mesa player
  var { data: mesa } = await sb.from('players').select('id').eq('email', 'samanta.marcal@gmail.com').single();
  var mesaId = mesa ? mesa.id : null;
  console.log('[OK] Mesa ID:', mesaId);
  if (mesaId) playerCache['FoodHub__mesa'] = mesaId;

  // Create all unique players
  var fornecedores = [...new Set(DEALS.map(function(d){return d.fornecedor}).filter(function(f){return f!=='A definir'&&f!=='FoodHub'}))];
  var clientes = [...new Set(DEALS.flatMap(function(d){return d.clientes}))];
  var sellers = [...new Set(DEALS.map(function(d){return d.seller}).filter(function(s){return s!=='FoodHub'}))];
  var originadores = [...new Set(DEALS.map(function(d){return d.originador}).filter(function(o){return o!=='FoodHub'}))];

  console.log('\n--- Industrias (' + fornecedores.length + ') ---');
  for (var f of fornecedores) { var id = await getOrCreatePlayer(f, 'industria'); console.log('  [OK] ' + f + ': ' + id); }

  console.log('\n--- Clientes (' + clientes.length + ') ---');
  for (var c of clientes) { var id = await getOrCreatePlayer(c, 'cliente'); console.log('  [OK] ' + c + ': ' + id); }

  console.log('\n--- Sellers (' + sellers.length + ') ---');
  for (var s of sellers) { var id = await getOrCreatePlayer(s, 'seller'); console.log('  [OK] ' + s + ': ' + id); }

  console.log('\n--- Originadores (' + originadores.length + ') ---');
  for (var o of originadores) { var id = await getOrCreatePlayer(o, 'originador'); console.log('  [OK] ' + o + ': ' + id); }

  // Create vinculos (originador → industria)
  console.log('\n--- Vinculos ---');
  for (var d of DEALS) {
    if (d.originador !== 'FoodHub' && d.fornecedor !== 'A definir' && d.fornecedor !== 'FoodHub') {
      var origId = playerCache[d.originador + '__originador'];
      var fornId = playerCache[d.fornecedor + '__industria'];
      if (origId && fornId) {
        var { error } = await sb.from('vinculos').insert({
          player_id: fornId,
          intermediario_id: origId,
          papel: 'originador',
          criado_em: new Date().toISOString()
        });
        if (!error) console.log('  [OK] ' + d.originador + ' → ' + d.fornecedor);
      }
    }
    if (d.seller !== 'FoodHub') {
      var sellId = playerCache[d.seller + '__seller'];
      var cliId = playerCache[d.clientes[0] + '__cliente'];
      if (sellId && cliId) {
        var { error } = await sb.from('vinculos').insert({
          player_id: cliId,
          intermediario_id: sellId,
          papel: 'seller',
          criado_em: new Date().toISOString()
        });
        if (!error) console.log('  [OK] ' + d.seller + ' → ' + d.clientes[0]);
      }
    }
  }

  // Migrate deals
  console.log('\n=== Migrando ' + DEALS.length + ' deals ===\n');
  var oportunidades = 0, deals = 0;
  var valorTotal = 0;

  for (var d of DEALS) {
    var codigo = 'PIP-' + String(d.num).padStart(4, '0');
    var clienteId = await getOrCreatePlayer(d.clientes[0], 'cliente');
    var fornecedorId = (d.fornecedor !== 'A definir' && d.fornecedor !== 'FoodHub') ? await getOrCreatePlayer(d.fornecedor, 'industria') : mesaId;
    var sellerId = d.seller !== 'FoodHub' ? (playerCache[d.seller + '__seller'] || mesaId) : mesaId;
    var originadorId = d.originador !== 'FoodHub' ? (playerCache[d.originador + '__originador'] || mesaId) : mesaId;
    valorTotal += d.potencial;

    // Create oportunidade
    var { data: opp, error: oppErr } = await sb.from('oportunidades').insert({
      codigo: codigo,
      cliente_id: clienteId,
      produto_descricao: d.deal,
      categoria: d.deal.toLowerCase().indexOf('frango') > -1 ? 'frango' : d.deal.toLowerCase().indexOf('bovino') > -1 ? 'bovino' : d.deal.toLowerCase().indexOf('calabresa') > -1 || d.deal.toLowerCase().indexOf('suino') > -1 ? 'suino' : null,
      regiao: d.regiao,
      preco_alvo: d.potencial,
      status: d.status === 'fechado' ? 'fechada' : d.status === 'em_andamento' ? 'ativa' : d.status,
      criado_em: new Date().toISOString()
    }).select('id').single();

    if (oppErr) { console.log('  [ERR] Opp #' + d.num + ': ' + oppErr.message); continue; }
    oportunidades++;

    // If deal is em_andamento or fechado, create a deal record
    if (d.status === 'em_andamento' || d.status === 'fechado') {
      var dealCodigo = 'DEA-' + String(d.num).padStart(4, '0');
      var { error: dealErr } = await sb.from('deals').insert({
        codigo: dealCodigo,
        oportunidade_id: opp.id,
        cliente_id: clienteId,
        industria_id: fornecedorId,
        seller_id: sellerId,
        originador_id: originadorId,
        total: d.potencial,
        status: d.status === 'fechado' ? 'fechado' : 'em_andamento',
        fechado_em: d.status === 'fechado' ? new Date().toISOString() : null,
        criado_em: new Date().toISOString()
      });
      if (dealErr) console.log('  [ERR] Deal #' + d.num + ': ' + dealErr.message);
      else { deals++; console.log('  [DEAL]  #' + d.num + ' ' + d.deal + ' → R$' + (d.potencial/1000000).toFixed(1) + 'M'); }
    } else {
      console.log('  [OPP]   #' + d.num + ' ' + d.deal + ' → R$' + (d.potencial/1000000).toFixed(1) + 'M');
    }

    // Create aprovacao
    await sb.from('aprovacoes_v2').insert({
      tipo: d.status === 'em_andamento' || d.status === 'fechado' ? 'deal' : 'oportunidade',
      entidade_id: opp.id,
      status: 'pendente',
      criado_em: new Date().toISOString()
    });
  }

  // Summary
  var { count: totalPlayers } = await sb.from('players').select('*', { count: 'exact', head: true });
  var { count: totalOpp } = await sb.from('oportunidades').select('*', { count: 'exact', head: true });
  var { count: totalDeals } = await sb.from('deals').select('*', { count: 'exact', head: true });
  var { count: totalVinc } = await sb.from('vinculos').select('*', { count: 'exact', head: true });
  var { count: totalAprov } = await sb.from('aprovacoes_v2').select('*', { count: 'exact', head: true });

  console.log('\n========================================');
  console.log('  MIGRACAO V3 FINAL CONCLUIDA');
  console.log('========================================');
  console.log('  Players:       ' + totalPlayers);
  console.log('  Vinculos:      ' + totalVinc);
  console.log('  Oportunidades: ' + totalOpp);
  console.log('  Deals:         ' + totalDeals);
  console.log('  Aprovacoes:    ' + totalAprov);
  console.log('  Valor total:   R$ ' + (valorTotal/1000000).toFixed(1) + 'M/mes');
  console.log('========================================\n');
}

run().catch(function(err) { console.error('FATAL:', err); });
