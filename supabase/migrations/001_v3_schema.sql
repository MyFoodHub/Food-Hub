-- FoodHub V3.0 — Schema completo com linha de aprovação
-- Gerado em 2026-04-18
-- Decisão: tabelas _v2 coexistem com as originais para não quebrar o MVP em produção

-- 1. MEMBERS (cadastro unificado)
CREATE TABLE IF NOT EXISTS members (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  tipo text NOT NULL CHECK (tipo IN ('comprador','fornecedor','seller','originador','mesa')),
  status text DEFAULT 'pendente' CHECK (status IN ('pendente','aguardando_aprovacao','ativo','suspenso','expulso','rejeitado')),
  nome text NOT NULL,
  razao_social text,
  cnpj text,
  cpf text,
  email text,
  whatsapp text UNIQUE,
  idioma text DEFAULT 'pt',
  originador_id uuid REFERENCES members(id),
  seller_id uuid REFERENCES members(id),
  aprovado_por uuid REFERENCES members(id),
  aprovado_em timestamptz,
  aprovado_via text,
  rejeitado_por uuid REFERENCES members(id),
  motivo_rejeicao text,
  contrato_assinado boolean DEFAULT false,
  contrato_url text,
  criado_em timestamptz DEFAULT now(),
  atualizado_em timestamptz DEFAULT now()
);

-- 2. COMPRADORES
CREATE TABLE IF NOT EXISTS compradores (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  member_id uuid REFERENCES members(id) UNIQUE,
  segmento text,
  canais text[],
  regioes_compra text[],
  categorias_interesse text[],
  volume_medio_mensal decimal(12,2),
  condicao_pagamento_padrao text,
  criado_em timestamptz DEFAULT now()
);

-- 3. FORNECEDORES_V2
CREATE TABLE IF NOT EXISTS fornecedores_v2 (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  member_id uuid REFERENCES members(id) UNIQUE,
  categorias text[],
  produtos text[],
  regioes_atendimento text[],
  tipos_frete text[],
  certificacoes text[],
  capacidade_mensal decimal(12,2),
  volume_minimo decimal(12,2),
  unidade_volume text DEFAULT 'kg',
  criado_em timestamptz DEFAULT now()
);

-- 4. SELLERS
CREATE TABLE IF NOT EXISTS sellers (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  member_id uuid REFERENCES members(id) UNIQUE,
  regioes_atuacao text[],
  clientes_vinculados uuid[],
  criado_em timestamptz DEFAULT now()
);

-- 5. ORIGINADORES
CREATE TABLE IF NOT EXISTS originadores (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  member_id uuid REFERENCES members(id) UNIQUE,
  fornecedores_trazidos uuid[],
  criado_em timestamptz DEFAULT now()
);

-- 6. CATEGORIAS REFERENCIA
CREATE TABLE IF NOT EXISTS categorias_referencia (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  categoria text UNIQUE,
  subcategorias_comuns text[],
  tags_comuns text[],
  criado_em timestamptz DEFAULT now()
);

-- 7. PRODUTOS (aberto + IA organiza)
CREATE TABLE IF NOT EXISTS produtos (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  descricao_livre text NOT NULL,
  categoria text,
  subcategoria text,
  nome_normalizado text,
  tags text[],
  variacoes jsonb,
  campos_relevantes text[],
  criado_por uuid REFERENCES members(id),
  status text DEFAULT 'rascunho' CHECK (status IN ('rascunho','revisado_ia','aguardando_aprovacao','aprovado','rejeitado')),
  revisado_por_ia boolean DEFAULT false,
  confianca_ia decimal(3,2),
  aprovado_por uuid REFERENCES members(id),
  aprovado_em timestamptz,
  motivo_rejeicao text,
  ativo boolean DEFAULT true,
  criado_em timestamptz DEFAULT now()
);

-- 8. DEMANDAS_V2
CREATE TABLE IF NOT EXISTS demandas_v2 (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  codigo text UNIQUE,
  comprador_id uuid REFERENCES members(id),
  produto_id uuid REFERENCES produtos(id),
  produto_nome text,
  especificacao jsonb,
  volume decimal(12,2),
  unidade text DEFAULT 'kg',
  regiao text,
  cidade text,
  frete text,
  prazo_expedicao_dias integer,
  prazo_pagamento text,
  preco_alvo decimal(12,2),
  certificacoes_exigidas text[],
  status text DEFAULT 'rascunho' CHECK (status IN ('rascunho','aguardando_aprovacao','ativa','pausada','expirada','cancelada')),
  mesa_ciente boolean DEFAULT false,
  aprovado_por uuid REFERENCES members(id),
  aprovado_em timestamptz,
  canal text DEFAULT 'web',
  criado_em timestamptz DEFAULT now(),
  expira_em timestamptz
);

-- 9. PROPOSTAS_V2
CREATE TABLE IF NOT EXISTS propostas_v2 (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  demanda_id uuid REFERENCES demandas_v2(id),
  fornecedor_id uuid REFERENCES members(id),
  preco_ofertado decimal(12,2),
  volume_disponivel decimal(12,2),
  prazo_expedicao_dias integer,
  condicao_pagamento text,
  frete text,
  certificacoes text[],
  observacoes text,
  score integer,
  status text DEFAULT 'recebida' CHECK (status IN ('recebida','mesa_ciente','em_negociacao','aceita','recusada','cancelada')),
  mesa_notificada boolean DEFAULT false,
  criado_em timestamptz DEFAULT now()
);

-- 10. NEGOCIACOES_V2
CREATE TABLE IF NOT EXISTS negociacoes_v2 (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  demanda_id uuid REFERENCES demandas_v2(id),
  proposta_id uuid REFERENCES propostas_v2(id),
  comprador_id uuid REFERENCES members(id),
  fornecedor_id uuid REFERENCES members(id),
  preco_atual decimal(12,2),
  status text DEFAULT 'em_andamento' CHECK (status IN ('em_andamento','mesa_ciente','fechada','cancelada')),
  mesa_notificada boolean DEFAULT false,
  criado_em timestamptz DEFAULT now(),
  fechado_em timestamptz
);

-- 11. MENSAGENS_V2
CREATE TABLE IF NOT EXISTS mensagens_v2 (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  negociacao_id uuid REFERENCES negociacoes_v2(id),
  remetente_id uuid REFERENCES members(id),
  sender text,
  conteudo text,
  tipo text DEFAULT 'texto',
  lida boolean DEFAULT false,
  canal text DEFAULT 'web',
  criado_em timestamptz DEFAULT now()
);

-- 12. PEDIDOS_V2
CREATE TABLE IF NOT EXISTS pedidos_v2 (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  codigo text UNIQUE,
  negociacao_id uuid REFERENCES negociacoes_v2(id),
  comprador_id uuid REFERENCES members(id),
  fornecedor_id uuid REFERENCES members(id),
  produto_nome text,
  especificacao jsonb,
  volume decimal(12,2),
  unidade text,
  preco_final decimal(12,2),
  total decimal(12,2),
  saving decimal(12,2),
  condicao_pagamento text,
  prazo_expedicao_dias integer,
  frete text,
  status text DEFAULT 'gerado' CHECK (status IN ('gerado','aprovado_mesa','confirmado','cancelado')),
  aprovado_por uuid REFERENCES members(id),
  aprovado_em timestamptz,
  aprovado_via text,
  criado_em timestamptz DEFAULT now()
);

-- 13. TRACKING_PEDIDO (recriar com FK para pedidos_v2)
-- Nota: tabela tracking_pedido já pode existir com FK para tabela pedidos antiga
-- Usar nome diferente para evitar conflito
CREATE TABLE IF NOT EXISTS tracking_v2 (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  pedido_id uuid REFERENCES pedidos_v2(id),
  fase text CHECK (fase IN (
    'confirmado','embarque_projetado','embarque_realizado',
    'nf_emitida','fatura_liquidada_cliente',
    'comissao_cobrada','comissao_paga','entregue'
  )),
  data_prevista date,
  data_realizada timestamptz,
  documento_url text,
  documento_lido_ia boolean DEFAULT false,
  dados_extraidos jsonb,
  observacao text,
  criado_em timestamptz DEFAULT now()
);

-- 14. FINANCIALS_V2
CREATE TABLE IF NOT EXISTS financials_v2 (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  pedido_id uuid REFERENCES pedidos_v2(id),
  fornecedor_id uuid REFERENCES members(id),
  valor_negocio decimal(12,2),
  comissao_tipo text CHECK (comissao_tipo IN ('percentual','por_kg')),
  comissao_pct decimal(5,4),
  comissao_por_kg decimal(8,4),
  comissao_total decimal(12,2),
  originador_id uuid REFERENCES members(id),
  originador_pct decimal(5,4),
  originador_valor decimal(12,2),
  seller_id uuid REFERENCES members(id),
  seller_pct decimal(5,4),
  seller_valor decimal(12,2),
  mesa_pct decimal(5,4),
  mesa_valor decimal(12,2),
  status text DEFAULT 'calculada' CHECK (status IN ('calculada','aprovada_mesa','aguardando_liquidacao','cobrada','paga','inadimplente')),
  aprovado_por uuid REFERENCES members(id),
  aprovado_em timestamptz,
  liquidacao_cliente_confirmada boolean DEFAULT false,
  liquidacao_fornecedor_confirmada boolean DEFAULT false,
  vencimento_comissao date,
  boleto_url text,
  nf_numero text,
  nf_url text,
  nf_data timestamptz,
  pago_em timestamptz,
  criado_em timestamptz DEFAULT now()
);

-- 15. ACORDOS_COMERCIAIS
CREATE TABLE IF NOT EXISTS acordos_comerciais (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  pedido_id uuid REFERENCES pedidos_v2(id),
  originador_id uuid REFERENCES members(id),
  seller_id uuid REFERENCES members(id),
  mesa_pct decimal(5,4),
  originador_pct decimal(5,4),
  seller_pct decimal(5,4),
  status text DEFAULT 'pendente' CHECK (status IN ('pendente','aprovado_mesa','ativo','cancelado')),
  aprovado_por uuid REFERENCES members(id),
  aprovado_em timestamptz,
  aceite_originador timestamptz,
  aceite_seller timestamptz,
  aceite_mesa timestamptz,
  criado_em timestamptz DEFAULT now()
);

-- 16. CONTRATOS
CREATE TABLE IF NOT EXISTS contratos (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  member_id uuid REFERENCES members(id),
  tipo text CHECK (tipo IN ('adesao','acordo_comercial','termo_negociacao')),
  pedido_id uuid REFERENCES pedidos_v2(id),
  documento_url text,
  aceite_timestamp timestamptz,
  aceite_ip text,
  status text DEFAULT 'pendente' CHECK (status IN ('pendente','aprovado_mesa','assinado','cancelado')),
  aprovado_por uuid REFERENCES members(id),
  criado_em timestamptz DEFAULT now()
);

-- 17. NF_DOCUMENTOS
CREATE TABLE IF NOT EXISTS nf_documentos (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  pedido_id uuid REFERENCES pedidos_v2(id),
  tipo text CHECK (tipo IN ('nf_produto','nf_servico_foodhub')),
  numero text,
  emitente_id uuid REFERENCES members(id),
  valor decimal(12,2),
  data_emissao timestamptz,
  arquivo_url text,
  lida_ia boolean DEFAULT false,
  dados_extraidos jsonb,
  status text DEFAULT 'pendente' CHECK (status IN ('pendente','validada_ia','aprovada_mesa','rejeitada')),
  aprovado_por uuid REFERENCES members(id),
  criado_em timestamptz DEFAULT now()
);

-- 18. APROVACOES (log central)
CREATE TABLE IF NOT EXISTS aprovacoes (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  tipo text NOT NULL,
  entidade_id uuid NOT NULL,
  entidade_codigo text,
  status text CHECK (status IN ('pendente','aprovado','rejeitado')),
  aprovado_por uuid REFERENCES members(id),
  aprovado_via text,
  aprovado_em timestamptz,
  motivo_rejeicao text,
  notificacao_enviada boolean DEFAULT false,
  criado_em timestamptz DEFAULT now()
);

-- 19. IA_LOGS
CREATE TABLE IF NOT EXISTS ia_logs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  agente text,
  member_id uuid REFERENCES members(id),
  canal text,
  input text,
  output text,
  intencao text,
  acao_tomada text,
  sucesso boolean,
  tempo_resposta_ms integer,
  criado_em timestamptz DEFAULT now()
);

-- 20. TAGS
CREATE TABLE IF NOT EXISTS tags (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  member_id uuid REFERENCES members(id),
  pedido_id uuid REFERENCES pedidos_v2(id),
  tag text,
  valor text,
  criado_em timestamptz DEFAULT now()
);

-- 21. NOTIFICACOES_V2
CREATE TABLE IF NOT EXISTS notificacoes_v2 (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  member_id uuid REFERENCES members(id),
  tipo text,
  titulo text,
  mensagem text,
  canal text CHECK (canal IN ('whatsapp','push','email','dashboard')),
  acao_requerida boolean DEFAULT false,
  acao_tipo text,
  acao_codigo text,
  lida boolean DEFAULT false,
  enviada boolean DEFAULT false,
  criado_em timestamptz DEFAULT now()
);
