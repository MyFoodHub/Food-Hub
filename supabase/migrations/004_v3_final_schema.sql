-- FoodHub V3 FINAL — Arquitetura definitiva
-- Players multi-papel, produtos livres com tags, matching por overlap
-- Data: 2026-04-19

-- 1. PLAYERS (cadastro único — qualquer um pode ter múltiplos papéis)
CREATE TABLE IF NOT EXISTS players (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  tipo text[],
  status text DEFAULT 'pendente',
  razao_social text NOT NULL,
  cnpj text,
  contato_nome text,
  email text UNIQUE,
  whatsapp text UNIQUE,
  idioma text DEFAULT 'pt',
  criado_em timestamptz DEFAULT now()
);

-- 2. VÍNCULOS (quem trouxe quem)
CREATE TABLE IF NOT EXISTS vinculos (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  player_id uuid REFERENCES players(id),
  intermediario_id uuid REFERENCES players(id),
  papel text,
  criado_em timestamptz DEFAULT now()
);

-- 3. PRODUTOS (catálogo livre — IA organiza)
CREATE TABLE IF NOT EXISTS produtos_v2 (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  industria_id uuid REFERENCES players(id),
  descricao_livre text NOT NULL,
  categoria text,
  tags text[],
  variacoes jsonb,
  canais text[],
  regioes text[],
  frete text[],
  status text DEFAULT 'aguardando_aprovacao',
  criado_em timestamptz DEFAULT now()
);

-- 4. OPORTUNIDADES (demandas dos clientes)
CREATE TABLE IF NOT EXISTS oportunidades (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  codigo text UNIQUE,
  cliente_id uuid REFERENCES players(id),
  produto_descricao text,
  categoria text,
  tags text[],
  volume decimal(12,2),
  unidade text,
  regiao text,
  frete text,
  prazo_expedicao text,
  prazo_pagamento text,
  preco_alvo decimal(12,2),
  status text DEFAULT 'aguardando_aprovacao',
  criado_em timestamptz DEFAULT now()
);

-- 5. PROPOSTAS
CREATE TABLE IF NOT EXISTS propostas_v3 (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  oportunidade_id uuid REFERENCES oportunidades(id),
  industria_id uuid REFERENCES players(id),
  preco decimal(12,2),
  volume decimal(12,2),
  prazo_expedicao text,
  condicao_pagamento text,
  frete text,
  score integer,
  status text DEFAULT 'enviada',
  criado_em timestamptz DEFAULT now()
);

-- 6. DEALS (negócio em andamento)
CREATE TABLE IF NOT EXISTS deals (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  codigo text UNIQUE,
  oportunidade_id uuid REFERENCES oportunidades(id),
  proposta_id uuid REFERENCES propostas_v3(id),
  cliente_id uuid REFERENCES players(id),
  industria_id uuid REFERENCES players(id),
  seller_id uuid REFERENCES players(id),
  originador_id uuid REFERENCES players(id),
  preco_final decimal(12,2),
  volume decimal(12,2),
  total decimal(12,2),
  saving decimal(12,2),
  status text DEFAULT 'em_andamento',
  criado_em timestamptz DEFAULT now(),
  fechado_em timestamptz
);

-- 7. COMISSÕES
CREATE TABLE IF NOT EXISTS comissoes (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  deal_id uuid REFERENCES deals(id),
  mesa_pct decimal(5,4),
  seller_pct decimal(5,4),
  originador_pct decimal(5,4),
  total_valor decimal(12,2),
  mesa_valor decimal(12,2),
  seller_valor decimal(12,2),
  originador_valor decimal(12,2),
  status text DEFAULT 'pendente',
  aprovado_em timestamptz,
  pago_em timestamptz,
  criado_em timestamptz DEFAULT now()
);

-- 8. CHAT DO DEAL
CREATE TABLE IF NOT EXISTS chat_deal (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  deal_id uuid REFERENCES deals(id),
  player_id uuid REFERENCES players(id),
  conteudo text,
  lida boolean DEFAULT false,
  criado_em timestamptz DEFAULT now()
);

-- 9. DOCUMENTOS
CREATE TABLE IF NOT EXISTS documentos (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  deal_id uuid REFERENCES deals(id),
  tipo text,
  url text,
  dados_extraidos jsonb,
  status text DEFAULT 'pendente',
  criado_em timestamptz DEFAULT now()
);

-- 10. APROVAÇÕES
CREATE TABLE IF NOT EXISTS aprovacoes_v2 (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  tipo text,
  entidade_id uuid,
  status text DEFAULT 'pendente',
  aprovado_por uuid REFERENCES players(id),
  aprovado_em timestamptz,
  motivo_rejeicao text,
  criado_em timestamptz DEFAULT now()
);

-- RLS
ALTER TABLE players ENABLE ROW LEVEL SECURITY;
ALTER TABLE vinculos ENABLE ROW LEVEL SECURITY;
ALTER TABLE produtos_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE oportunidades ENABLE ROW LEVEL SECURITY;
ALTER TABLE propostas_v3 ENABLE ROW LEVEL SECURITY;
ALTER TABLE deals ENABLE ROW LEVEL SECURITY;
ALTER TABLE comissoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_deal ENABLE ROW LEVEL SECURITY;
ALTER TABLE documentos ENABLE ROW LEVEL SECURITY;
ALTER TABLE aprovacoes_v2 ENABLE ROW LEVEL SECURITY;
