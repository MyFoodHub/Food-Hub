-- Faturamento + NF uploads
ALTER TABLE deal_produtos ADD COLUMN IF NOT EXISTS nf_url text;
ALTER TABLE deal_produtos ADD COLUMN IF NOT EXISTS nf_numero text;
ALTER TABLE deal_produtos ADD COLUMN IF NOT EXISTS status text DEFAULT 'pendente';

ALTER TABLE deals ADD COLUMN IF NOT EXISTS status_faturamento text DEFAULT 'pendente';

CREATE TABLE IF NOT EXISTS nf_uploads (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  deal_id uuid REFERENCES deals(id),
  deal_produto_id uuid REFERENCES deal_produtos(id),
  nf_numero text,
  nf_url text,
  valor_nf decimal(12,2),
  volume_nf decimal(12,2),
  unidade text,
  dados_extraidos jsonb,
  lida_ia boolean DEFAULT false,
  status text DEFAULT 'pendente',
  criado_em timestamptz DEFAULT now()
);

ALTER TABLE nf_uploads ENABLE ROW LEVEL SECURITY;
