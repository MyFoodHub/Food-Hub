-- Deal produtos — cada deal pode ter múltiplos produtos
CREATE TABLE IF NOT EXISTS deal_produtos (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  deal_id uuid REFERENCES deals(id),
  oportunidade_id uuid REFERENCES oportunidades(id),
  produto_descricao text,
  volume decimal(12,2),
  unidade text DEFAULT 'kg',
  preco_unitario decimal(12,4),
  valor_total decimal(12,2),
  comissao_pct decimal(5,4),
  comissao_valor decimal(12,2),
  criado_em timestamptz DEFAULT now()
);

ALTER TABLE deal_produtos ENABLE ROW LEVEL SECURITY;

-- Observacoes column on oportunidades (for IA instructions)
ALTER TABLE oportunidades ADD COLUMN IF NOT EXISTS observacoes text;
