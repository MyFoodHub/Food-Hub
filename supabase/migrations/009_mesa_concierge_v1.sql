-- ============================================================
-- 009_mesa_concierge_v1.sql
-- Sessão 2 — Schema mínimo Mesa Concierge V1
-- Data: 2026-04-27 | CEO: Humberto Abílio | Co: Samanta Marçal
-- ============================================================
-- Decisões S1 (25/abr):   D1..D9   (docs/arquitetura-mesa-concierge-v1.md §8)
-- Decisões S1.5 (26/abr): D1..D17  (docs/diagnostico-banco-pre-s2.md §7)
-- Decisões S2 (27/abr):   D21..D31 (Mesa Estratégica)
-- Regras de negócio:      RN1..RN9
--
-- Apply: copiar+colar no Dashboard SQL Editor (Supabase).
--        NÃO rodar `supabase db push` daqui.
-- Idempotência: cada bloco rodar duas vezes é no-op.
-- Transação: BEGIN/COMMIT por bloco — falha de bloco N não
--            afeta blocos 1..N-1 já aplicados.
--
-- Status: APLICADO COM SUCESSO em 27/04/2026 via Dashboard.
-- Validações finais (B20):
--   - 15 tabelas com RLS ativo
--   - 6 funções SQL (5 helpers + calcular_split_comissao)
--   - 8 triggers críticos
--   - 11 etapas SLA seedadas
--   - 52 policies RLS distribuídas
--   - 2 CHECK constraints contra self-reference
--
-- Blocos (20 stops macro):
--   B01  ALTER players (+9 colunas)
--   B02  ALTER oportunidades (+4 colunas)
--   B03  ALTER propostas_v3 (+2 colunas + RENAME score→score_total)
--   B04  ALTER deals (+5 colunas: 3 etapa + 2 snapshot carteira)
--   B05  CREATE oportunidade_convites
--   B06  CREATE deal_produtos_comissao
--   B07  Backfill NO-OP + COMMENT DEPRECATED em deal_produtos
--   B08  CREATE deal_eventos + trigger imutabilidade
--   B09  CREATE termos_acordo
--   B10  CREATE comunicacoes
--   B11  REFATORAR comissoes (linha-por-papel)
--   B12  CREATE comissoes_periodo
--   B13  CREATE etapa_sla_padrao + seed 11 etapas
--   B14  Helpers SQL (5 funções, leem snapshot em deals)
--   B15  Função calcular_split_comissao() (média ponderada D31)
--   B16  Trigger piso 0,5% individual em deal_produtos_comissao
--   B17  Trigger termos_acordo (auto-avanço + split)
--   B18  Trigger carteira vitalícia + auditoria_carteira
--   B19  RLS em 15 tabelas (52 policies, 5 sub-blocos B19a-e)
--   B20  Smoke test (rodado apenas no Dashboard, ver §12 do
--         diagnostico-banco-pre-s2.md)
-- ============================================================


-- ────────────────────────────────────────────────────────────
-- B01 — ALTER players (+9 colunas)
-- Refs: arquitetura §3.1 + diagnóstico §2.1 + RN7/D22
-- 43 linhas vivas. Defaults seguros — sem UPDATE manual em S2.
-- Auto-ref de seller_id/originador_id proibida (CHECK).
-- Mudança vitalícia + auditoria via trigger B18 (criado depois).
-- ROLLBACK: ALTER TABLE players DROP COLUMN auth_user_id, ativo,
--   bloqueado_em, bloqueado_motivo, onboarding_status,
--   convite_token, sif, seller_id, originador_id;
-- ────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE players
  ADD COLUMN IF NOT EXISTS auth_user_id      uuid,
  ADD COLUMN IF NOT EXISTS ativo             boolean     NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS bloqueado_em      timestamptz,
  ADD COLUMN IF NOT EXISTS bloqueado_motivo  text,
  ADD COLUMN IF NOT EXISTS onboarding_status text        NOT NULL DEFAULT 'convidado',
  ADD COLUMN IF NOT EXISTS convite_token     text,
  ADD COLUMN IF NOT EXISTS sif               text,
  ADD COLUMN IF NOT EXISTS seller_id         uuid,
  ADD COLUMN IF NOT EXISTS originador_id     uuid;

ALTER TABLE players DROP CONSTRAINT IF EXISTS players_onboarding_status_check;
ALTER TABLE players ADD CONSTRAINT players_onboarding_status_check
  CHECK (onboarding_status IN ('convidado','kyc_iniciado','kyc_completo','ativo','bloqueado'));

DROP INDEX IF EXISTS players_convite_token_uniq;
CREATE UNIQUE INDEX players_convite_token_uniq
  ON players (convite_token) WHERE convite_token IS NOT NULL;

ALTER TABLE players DROP CONSTRAINT IF EXISTS players_seller_id_fk;
ALTER TABLE players ADD CONSTRAINT players_seller_id_fk
  FOREIGN KEY (seller_id) REFERENCES players(id) ON DELETE SET NULL;
ALTER TABLE players DROP CONSTRAINT IF EXISTS players_seller_no_self;
ALTER TABLE players ADD CONSTRAINT players_seller_no_self
  CHECK (seller_id IS NULL OR seller_id <> id);

ALTER TABLE players DROP CONSTRAINT IF EXISTS players_originador_id_fk;
ALTER TABLE players ADD CONSTRAINT players_originador_id_fk
  FOREIGN KEY (originador_id) REFERENCES players(id) ON DELETE SET NULL;
ALTER TABLE players DROP CONSTRAINT IF EXISTS players_originador_no_self;
ALTER TABLE players ADD CONSTRAINT players_originador_no_self
  CHECK (originador_id IS NULL OR originador_id <> id);

COMMENT ON COLUMN players.auth_user_id      IS 'FK lógico p/ auth.users (sem REFERENCES cross-schema)';
COMMENT ON COLUMN players.ativo             IS 'Bloqueio mole. False + bloqueado_motivo travam acesso. RN4.';
COMMENT ON COLUMN players.onboarding_status IS 'convidado→kyc_iniciado→kyc_completo→ativo→bloqueado';
COMMENT ON COLUMN players.convite_token     IS 'URL entrar.html?convite=<token>; UNIQUE quando preenchido';
COMMENT ON COLUMN players.sif               IS 'Apenas indústria de cárneos/lácteos';
COMMENT ON COLUMN players.seller_id         IS 'RN7/D22 — Vínculo vitalício (cliente→seller). NULL = mesa solo. Trigger B18 protege e audita.';
COMMENT ON COLUMN players.originador_id     IS 'RN7/D22 — Vínculo vitalício (indústria→originador). NULL = mesa solo. Trigger B18 protege e audita.';

COMMIT;


-- ────────────────────────────────────────────────────────────
-- B02 — ALTER oportunidades (+4 colunas)
-- Refs: arquitetura §3.2 + diagnóstico §2.1
-- 26 linhas vivas. Defaults aplicados retroativamente em S2.
-- modo_distribuicao default 'broadcast'.
-- status_cliente default 'pendente' (4 estados).
-- ROLLBACK: ALTER TABLE oportunidades
--   DROP COLUMN modo_distribuicao, status_cliente,
--               prometida_em, expira_em;
-- ────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE oportunidades
  ADD COLUMN IF NOT EXISTS modo_distribuicao text NOT NULL DEFAULT 'broadcast',
  ADD COLUMN IF NOT EXISTS status_cliente    text NOT NULL DEFAULT 'pendente',
  ADD COLUMN IF NOT EXISTS prometida_em      timestamptz,
  ADD COLUMN IF NOT EXISTS expira_em         timestamptz;

ALTER TABLE oportunidades DROP CONSTRAINT IF EXISTS oportunidades_modo_distribuicao_check;
ALTER TABLE oportunidades ADD CONSTRAINT oportunidades_modo_distribuicao_check
  CHECK (modo_distribuicao IN ('broadcast','curado'));

ALTER TABLE oportunidades DROP CONSTRAINT IF EXISTS oportunidades_status_cliente_check;
ALTER TABLE oportunidades ADD CONSTRAINT oportunidades_status_cliente_check
  CHECK (status_cliente IN ('pendente','aprovado','rejeitado','expirado'));

COMMENT ON COLUMN oportunidades.modo_distribuicao IS 'broadcast (todos veem) ou curado (mesa escolhe quem recebe convite). Default broadcast.';
COMMENT ON COLUMN oportunidades.status_cliente    IS 'pendente→aprovado→rejeitado→expirado. Aprovação curatorial pela mesa.';
COMMENT ON COLUMN oportunidades.prometida_em      IS 'Data/hora em que mesa prometeu resposta ao cliente. SLA Pilar 2.';
COMMENT ON COLUMN oportunidades.expira_em         IS 'Quando oportunidade expira. Após isso = expirada automaticamente.';

COMMIT;


-- ────────────────────────────────────────────────────────────
-- B03 — ALTER propostas_v3 (+2 colunas + RENAME score→score_total)
-- Refs: arquitetura §3.3 + diagnóstico §2.1 + RN2
-- 0 linhas no banco. Risco zero. Front V0 não usa propostas_v3.
-- score_total computado em S3 (RN2: 60% preço + 15% prazo + 10% frete + 15% supplier).
-- ROLLBACK: ALTER TABLE propostas_v3 DROP COLUMN tipo, hit;
--           ALTER TABLE propostas_v3 RENAME COLUMN score_total TO score;
-- ────────────────────────────────────────────────────────────

BEGIN;

-- RENAME score → score_total (idempotente via DO block)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns 
             WHERE table_schema='public' AND table_name='propostas_v3' 
             AND column_name='score')
  AND NOT EXISTS (SELECT 1 FROM information_schema.columns 
                  WHERE table_schema='public' AND table_name='propostas_v3' 
                  AND column_name='score_total') THEN
    ALTER TABLE propostas_v3 RENAME COLUMN score TO score_total;
  END IF;
END $$;

ALTER TABLE propostas_v3
  ADD COLUMN IF NOT EXISTS tipo text    NOT NULL DEFAULT 'oferta',
  ADD COLUMN IF NOT EXISTS hit  boolean NOT NULL DEFAULT false;

ALTER TABLE propostas_v3 DROP CONSTRAINT IF EXISTS propostas_v3_tipo_check;
ALTER TABLE propostas_v3 ADD CONSTRAINT propostas_v3_tipo_check
  CHECK (tipo IN ('oferta','contraoferta','revisao'));

COMMENT ON COLUMN propostas_v3.tipo        IS 'oferta (inicial) | contraoferta (resposta cliente) | revisao (ajuste pós-feedback). RN2.';
COMMENT ON COLUMN propostas_v3.hit         IS 'true = proposta aceita pelo cliente (vira deal). RN2.';
COMMENT ON COLUMN propostas_v3.score_total IS 'RN2 — Score 60% preço + 15% prazo + 10% frete + 15% supplier. RPC em S3.';

COMMIT;


-- ────────────────────────────────────────────────────────────
-- B04 — ALTER deals (+5 colunas: 3 etapa + 2 snapshot carteira)
-- Refs: arquitetura §3.4 + RN3/D8 + RN7/D29
-- 2 linhas teste. etapa_atual default=1 (D8).
-- Snapshots seller_id/originador_id_snapshot são imutáveis após
-- INSERT (Pilar 4 — Transparência da carteira). Trigger no INSERT
-- copia de cliente/industria — ver B17/B18.
-- ROLLBACK: ALTER TABLE deals DROP COLUMN etapa_atual,
--   etapa_iniciada_em, concluido_em, seller_id_snapshot,
--   originador_id_snapshot;
-- ────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS etapa_atual            smallint    NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS etapa_iniciada_em      timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS concluido_em           timestamptz,
  ADD COLUMN IF NOT EXISTS seller_id_snapshot     uuid,
  ADD COLUMN IF NOT EXISTS originador_id_snapshot uuid;

ALTER TABLE deals DROP CONSTRAINT IF EXISTS deals_etapa_atual_check;
ALTER TABLE deals ADD CONSTRAINT deals_etapa_atual_check
  CHECK (etapa_atual BETWEEN 1 AND 11);

ALTER TABLE deals DROP CONSTRAINT IF EXISTS deals_seller_snapshot_fk;
ALTER TABLE deals ADD CONSTRAINT deals_seller_snapshot_fk
  FOREIGN KEY (seller_id_snapshot) REFERENCES players(id) ON DELETE SET NULL;

ALTER TABLE deals DROP CONSTRAINT IF EXISTS deals_originador_snapshot_fk;
ALTER TABLE deals ADD CONSTRAINT deals_originador_snapshot_fk
  FOREIGN KEY (originador_id_snapshot) REFERENCES players(id) ON DELETE SET NULL;

COMMENT ON COLUMN deals.etapa_atual            IS 'RN3/D8 — Etapa 1..11 do fluxograma. Default 1 (Deal criado).';
COMMENT ON COLUMN deals.etapa_iniciada_em      IS 'Quando a etapa atual foi iniciada. Usado para SLA (RN3).';
COMMENT ON COLUMN deals.concluido_em           IS 'Quando deal chegou na etapa 11 (split realizado). NULL = ativo.';
COMMENT ON COLUMN deals.seller_id_snapshot     IS 'RN7/D29 — Snapshot do seller no momento da criação. IMUTÁVEL.';
COMMENT ON COLUMN deals.originador_id_snapshot IS 'RN7/D29 — Snapshot do originador no momento da criação. IMUTÁVEL.';

COMMIT;


-- ────────────────────────────────────────────────────────────
-- B05 — CREATE oportunidade_convites
-- Refs: arquitetura §4.1 + diagnóstico §2.2
-- Tabela NOVA. Cada linha = 1 convite enviado pra fornecedor
-- responder a uma oportunidade específica.
-- Pilar 5 (Curadoria): mesa decide quem convida.
-- ROLLBACK: DROP TABLE IF EXISTS oportunidade_convites CASCADE;
-- ────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS oportunidade_convites (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  oportunidade_id   uuid NOT NULL REFERENCES oportunidades(id) ON DELETE CASCADE,
  industria_id      uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  status            text NOT NULL DEFAULT 'enviado',
  enviado_em        timestamptz NOT NULL DEFAULT now(),
  aberto_em         timestamptz,
  respondido_em     timestamptz,
  motivo_rejeicao   text,
  criado_em         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (oportunidade_id, industria_id)
);

ALTER TABLE oportunidade_convites DROP CONSTRAINT IF EXISTS oportunidade_convites_status_check;
ALTER TABLE oportunidade_convites ADD CONSTRAINT oportunidade_convites_status_check
  CHECK (status IN ('enviado','aberto','respondido','recusado','expirado'));

CREATE INDEX IF NOT EXISTS idx_oportunidade_convites_oportunidade
  ON oportunidade_convites(oportunidade_id);
CREATE INDEX IF NOT EXISTS idx_oportunidade_convites_industria
  ON oportunidade_convites(industria_id);

COMMENT ON TABLE  oportunidade_convites           IS 'Pilar 5 — Curadoria: mesa decide quem convida pra cada oportunidade.';
COMMENT ON COLUMN oportunidade_convites.status    IS 'enviado→aberto→respondido | recusado | expirado';
COMMENT ON COLUMN oportunidade_convites.aberto_em IS 'Quando indústria abriu o convite (tracking via Resend).';

COMMIT;


-- ────────────────────────────────────────────────────────────
-- B06 — CREATE deal_produtos_comissao
-- Refs: arquitetura §4.2 + RN1/D28 (piso individual SKU)
-- Tabela NOVA. PK = deal_produto_id (1:1 com deal_produtos).
-- Trigger piso 0,5% individual vem em B16.
-- Pilar 3 (Ganho Compartilhado): comissão por SKU >= 0,5%.
-- ROLLBACK: DROP TABLE IF EXISTS deal_produtos_comissao CASCADE;
-- ────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS deal_produtos_comissao (
  deal_produto_id    uuid PRIMARY KEY REFERENCES deal_produtos(id) ON DELETE CASCADE,
  comissao_pct       numeric(5,4) NOT NULL CHECK (comissao_pct >= 0.005),
  comissao_valor     numeric(12,2),
  criado_em          timestamptz NOT NULL DEFAULT now(),
  atualizado_em      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_deal_produtos_comissao_pct
  ON deal_produtos_comissao(comissao_pct);

COMMENT ON TABLE  deal_produtos_comissao                IS 'RN1/D28 — Comissão por SKU. Piso 0,5% individual (CHECK + trigger B16).';
COMMENT ON COLUMN deal_produtos_comissao.comissao_pct   IS 'Pilar 3 — Comissão SKU >= 0,5%. NUMERIC(5,4) = 4 casas decimais.';
COMMENT ON COLUMN deal_produtos_comissao.comissao_valor IS 'R$ absoluto preenchido pelo financeiro (RN9).';

COMMIT;


-- ────────────────────────────────────────────────────────────
-- B07 — Backfill NO-OP + COMMENT DEPRECATED em deal_produtos
-- Refs: diagnóstico §8.1 D7
-- deal_produtos.comissao_pct/valor (legado V0) marcadas DEPRECATED.
-- Backfill: INSERT...SELECT é NO-OP (deal_produtos tem 0 linhas).
-- DROP das colunas legadas só em S5 (D7).
-- ROLLBACK: COMMENT ON COLUMN ... IS NULL (limpa comentário).
-- ────────────────────────────────────────────────────────────

BEGIN;

-- Backfill (NO-OP — 0 linhas em deal_produtos hoje)
INSERT INTO deal_produtos_comissao (deal_produto_id, comissao_pct, comissao_valor)
SELECT id, comissao_pct, comissao_valor
FROM deal_produtos
WHERE comissao_pct IS NOT NULL
  AND comissao_pct >= 0.005
ON CONFLICT (deal_produto_id) DO NOTHING;

-- Marca colunas legadas como DEPRECATED
COMMENT ON COLUMN deal_produtos.comissao_pct   IS 'DEPRECATED — ler de deal_produtos_comissao. DROP previsto em S5.';
COMMENT ON COLUMN deal_produtos.comissao_valor IS 'DEPRECATED — ler de deal_produtos_comissao. DROP previsto em S5.';

COMMIT;


-- ────────────────────────────────────────────────────────────
-- B08 — CREATE deal_eventos + trigger imutabilidade
-- Refs: arquitetura §4.3 + RN5 + Pilar 4 (Transparência)
-- Tabela NOVA. Log imutável de eventos por deal.
-- Trigger BEFORE UPDATE/DELETE: RAISE EXCEPTION (jamais altera evento).
-- Pilar 4: histórico imutável = auditoria garantida.
-- ROLLBACK: DROP TABLE IF EXISTS deal_eventos CASCADE;
-- ────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS deal_eventos (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id       uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  tipo          text NOT NULL,
  ator_id       uuid REFERENCES players(id),
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  criado_em     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE deal_eventos DROP CONSTRAINT IF EXISTS deal_eventos_tipo_check;
ALTER TABLE deal_eventos ADD CONSTRAINT deal_eventos_tipo_check
  CHECK (tipo IN (
    'DEAL_CRIADO',
    'TERMO_ENVIADO',
    'TERMO_ASSINADO',
    'TERMO_ASSINADO_TODOS',
    'PEDIDO_RECEBIDO',
    'ACEITE_FORNECEDOR',
    'NF_SUBIDA',
    'ENTREGA_CONFIRMADA',
    'LIQUIDACAO_CONFIRMADA',
    'BOLETO_FOODHUB_EMITIDO',
    'COMISSAO_RECEBIDA',
    'SPLIT_REPASSADO',
    'CARTEIRA_ALTERADA',
    'STATUS_ALTERADO',
    'OBSERVACAO'
  ));

CREATE INDEX IF NOT EXISTS idx_deal_eventos_deal       ON deal_eventos(deal_id);
CREATE INDEX IF NOT EXISTS idx_deal_eventos_criado_em  ON deal_eventos(criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_deal_eventos_tipo       ON deal_eventos(tipo);

-- Função de imutabilidade
CREATE OR REPLACE FUNCTION fn_deal_eventos_imutavel()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'deal_eventos é imutável (Pilar 4 — Transparência Radical). UPDATE/DELETE proibido.';
END;
$$ LANGUAGE plpgsql;

-- Trigger BEFORE UPDATE
DROP TRIGGER IF EXISTS tg_deal_eventos_no_update ON deal_eventos;
CREATE TRIGGER tg_deal_eventos_no_update
  BEFORE UPDATE ON deal_eventos
  FOR EACH ROW
  EXECUTE FUNCTION fn_deal_eventos_imutavel();

-- Trigger BEFORE DELETE
DROP TRIGGER IF EXISTS tg_deal_eventos_no_delete ON deal_eventos;
CREATE TRIGGER tg_deal_eventos_no_delete
  BEFORE DELETE ON deal_eventos
  FOR EACH ROW
  EXECUTE FUNCTION fn_deal_eventos_imutavel();

COMMENT ON TABLE  deal_eventos          IS 'Pilar 4 — Histórico imutável de eventos por deal. UPDATE/DELETE proibido.';
COMMENT ON COLUMN deal_eventos.tipo     IS '15 tipos pré-definidos (CHECK constraint).';
COMMENT ON COLUMN deal_eventos.payload  IS 'JSONB livre com detalhes do evento (valores antes/depois, etc).';
COMMENT ON COLUMN deal_eventos.ator_id  IS 'Player que disparou o evento. NULL se sistema/automação.';

COMMIT;


-- ────────────────────────────────────────────────────────────
-- B09 — CREATE termos_acordo
-- Refs: arquitetura §4.4 + Pilar 2 (Velocidade) + ClickSign (S4)
-- Tabela NOVA. Trigger AFTER UPDATE com auto-avanço de etapa
-- + chamada calcular_split_comissao vem em B17.
-- ROLLBACK: DROP TABLE IF EXISTS termos_acordo CASCADE;
-- ────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS termos_acordo (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id                     uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  status                      text NOT NULL DEFAULT 'rascunho',
  clicksign_document_id       text,
  pdf_url                     text,
  
  -- 3 assinaturas necessárias (Pilar 2 — visíveis pra todos)
  cliente_assinado_em         timestamptz,
  fornecedor_assinado_em      timestamptz,
  mesa_assinada_em            timestamptz,
  
  -- Metadados
  comissao_pct_global         numeric(5,4),
  observacoes                 text,
  criado_em                   timestamptz NOT NULL DEFAULT now(),
  atualizado_em               timestamptz NOT NULL DEFAULT now(),
  assinado_todos_em           timestamptz,
  
  UNIQUE (deal_id)
);

ALTER TABLE termos_acordo DROP CONSTRAINT IF EXISTS termos_acordo_status_check;
ALTER TABLE termos_acordo ADD CONSTRAINT termos_acordo_status_check
  CHECK (status IN (
    'rascunho',
    'enviado_clicksign',
    'aguardando_assinaturas',
    'assinado_parcial',
    'assinado_todos',
    'cancelado'
  ));

CREATE INDEX IF NOT EXISTS idx_termos_acordo_deal           ON termos_acordo(deal_id);
CREATE INDEX IF NOT EXISTS idx_termos_acordo_status         ON termos_acordo(status);
CREATE INDEX IF NOT EXISTS idx_termos_acordo_clicksign_doc  ON termos_acordo(clicksign_document_id) WHERE clicksign_document_id IS NOT NULL;

COMMENT ON TABLE  termos_acordo                          IS 'Termo de acordo do deal (etapa 2). Integração ClickSign em S4. Trigger auto-avanço B17.';
COMMENT ON COLUMN termos_acordo.status                   IS 'rascunho→enviado_clicksign→aguardando→assinado_parcial→assinado_todos. Status assinado_todos dispara trigger B17.';
COMMENT ON COLUMN termos_acordo.clicksign_document_id    IS 'ID do documento no ClickSign para webhook reconciliar (S4).';
COMMENT ON COLUMN termos_acordo.comissao_pct_global      IS 'RN1 — Comissão global do deal negociada no termo. Usada por B15 (calcular_split).';
COMMENT ON COLUMN termos_acordo.assinado_todos_em        IS 'Timestamp quando 3 assinaturas estão presentes. Trigger B17 popula.';

COMMIT;


-- ────────────────────────────────────────────────────────────
-- B10 — CREATE comunicacoes
-- Refs: arquitetura §4.5 + RN5 + Pilar 4 (Transparência)
-- Tabela NOVA. Log de TODA notificação enviada (Resend, WhatsApp manual).
-- Edge Function Resend (S4) consome esta tabela.
-- ROLLBACK: DROP TABLE IF EXISTS comunicacoes CASCADE;
-- ────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS comunicacoes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id           uuid REFERENCES deals(id) ON DELETE SET NULL,
  oportunidade_id   uuid REFERENCES oportunidades(id) ON DELETE SET NULL,
  destinatario_id   uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  
  canal             text NOT NULL,
  evento            text NOT NULL,
  status            text NOT NULL DEFAULT 'pendente',
  
  assunto           text,
  corpo             text,
  payload           jsonb DEFAULT '{}'::jsonb,
  
  resend_email_id   text,
  erro_mensagem     text,
  
  enviado_em        timestamptz,
  entregue_em       timestamptz,
  lido_em           timestamptz,
  criado_em         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE comunicacoes DROP CONSTRAINT IF EXISTS comunicacoes_canal_check;
ALTER TABLE comunicacoes ADD CONSTRAINT comunicacoes_canal_check
  CHECK (canal IN ('email_resend','whatsapp_manual','push_admin','sms'));

ALTER TABLE comunicacoes DROP CONSTRAINT IF EXISTS comunicacoes_status_check;
ALTER TABLE comunicacoes ADD CONSTRAINT comunicacoes_status_check
  CHECK (status IN ('pendente','enviada','entregue','lida','falhou','cancelada'));

ALTER TABLE comunicacoes DROP CONSTRAINT IF EXISTS comunicacoes_evento_check;
ALTER TABLE comunicacoes ADD CONSTRAINT comunicacoes_evento_check
  CHECK (evento IN (
    'CONVITE_ENVIADO',
    'CONVITE_ABERTO',
    'PROPOSTA_RECEBIDA',
    'DEAL_CRIADO',
    'TERMO_PENDENTE',
    'TERMO_ASSINADO',
    'NF_SUBIDA',
    'ENTREGA_CONFIRMADA',
    'LIQUIDACAO_OK',
    'BOLETO_FOODHUB',
    'COMISSAO_PAGA',
    'SPLIT_REPASSADO',
    'YELLOW_FLAG',
    'RED_FLAG'
  ));

CREATE INDEX IF NOT EXISTS idx_comunicacoes_deal             ON comunicacoes(deal_id);
CREATE INDEX IF NOT EXISTS idx_comunicacoes_destinatario     ON comunicacoes(destinatario_id);
CREATE INDEX IF NOT EXISTS idx_comunicacoes_status           ON comunicacoes(status);
CREATE INDEX IF NOT EXISTS idx_comunicacoes_pendentes        ON comunicacoes(status) WHERE status='pendente';
CREATE INDEX IF NOT EXISTS idx_comunicacoes_criado           ON comunicacoes(criado_em DESC);

COMMENT ON TABLE  comunicacoes                  IS 'RN5 — Log de notificações. Edge Function Resend processa pendentes em S4.';
COMMENT ON COLUMN comunicacoes.canal            IS 'email_resend (V1) | whatsapp_manual | push_admin | sms (V2)';
COMMENT ON COLUMN comunicacoes.evento           IS '14 tipos pré-definidos. Yellow/Red flag = atrasos SLA (V1.5).';
COMMENT ON COLUMN comunicacoes.resend_email_id  IS 'ID retornado pela Resend API para tracking.';

COMMIT;


-- ────────────────────────────────────────────────────────────
-- B11 — REFATORAR comissoes (schema linha-por-papel)
-- Refs: D-2 ajustes + RN4/D21 + RN8/D24 + RN9/D25
-- DROP TABLE — segura porque diagnóstico Q1 confirma 0 linhas.
-- Schema novo: 1 linha por papel por deal (mesa, seller, originador).
-- RLS por linha em B19c (D-2): cada papel vê APENAS sua linha.
-- ROLLBACK: DROP TABLE IF EXISTS comissoes CASCADE; (recria antiga)
-- ────────────────────────────────────────────────────────────

BEGIN;

-- Drop tabela antiga (0 linhas confirmadas)
DROP TABLE IF EXISTS comissoes CASCADE;

-- Recria com schema novo (linha por papel)
CREATE TABLE comissoes (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id               uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  papel                 text NOT NULL,
  player_id             uuid REFERENCES players(id) ON DELETE SET NULL,
  
  -- CAMADA 1 (sempre visível — RN9)
  comissao_pct          numeric(5,4) NOT NULL CHECK (comissao_pct > 0),
  comissao_valor_bruto  numeric(12,2),
  comissao_valor_liquido numeric(12,2),
  
  -- CAMADA 2 (pop-up tributos — RN9)
  composicao_tributos   jsonb DEFAULT '{}'::jsonb,
  
  -- CAMADA 3 (consolidação mensal — RN9)
  periodo_referencia    text,
  comissoes_periodo_id  uuid,
  
  -- Status (workflow)
  status                text NOT NULL DEFAULT 'pendente',
  observacoes           text,
  
  -- Auditoria
  fechado_em            timestamptz,
  fechado_por           uuid REFERENCES players(id),
  pago_em               timestamptz,
  
  criado_em             timestamptz NOT NULL DEFAULT now(),
  atualizado_em         timestamptz NOT NULL DEFAULT now(),
  
  -- 1 linha por papel por deal
  UNIQUE (deal_id, papel)
);

ALTER TABLE comissoes ADD CONSTRAINT comissoes_papel_check
  CHECK (papel IN ('mesa','seller','originador'));

ALTER TABLE comissoes ADD CONSTRAINT comissoes_status_check
  CHECK (status IN ('pendente','estruturada','fechada_periodo','paga'));

-- Mesa não tem player_id (NULL); seller/originador SEMPRE têm
ALTER TABLE comissoes ADD CONSTRAINT comissoes_player_id_consistencia_check
  CHECK (
    (papel = 'mesa' AND player_id IS NULL) OR
    (papel IN ('seller','originador') AND player_id IS NOT NULL)
  );

-- Periodo no formato YYYY-MM
ALTER TABLE comissoes ADD CONSTRAINT comissoes_periodo_formato_check
  CHECK (periodo_referencia IS NULL OR periodo_referencia ~ '^[0-9]{4}-[0-9]{2}$');

CREATE INDEX idx_comissoes_deal           ON comissoes(deal_id);
CREATE INDEX idx_comissoes_player         ON comissoes(player_id) WHERE player_id IS NOT NULL;
CREATE INDEX idx_comissoes_papel          ON comissoes(papel);
CREATE INDEX idx_comissoes_status         ON comissoes(status);
CREATE INDEX idx_comissoes_periodo        ON comissoes(periodo_referencia) WHERE periodo_referencia IS NOT NULL;

COMMENT ON TABLE  comissoes                       IS 'D-2/RN4/RN8/RN9 — Schema linha-por-papel. 1 linha = 1 papel (mesa/seller/originador) em 1 deal.';
COMMENT ON COLUMN comissoes.papel                 IS 'mesa | seller | originador. UNIQUE(deal_id,papel) garante 1 linha por papel.';
COMMENT ON COLUMN comissoes.player_id             IS 'NULL para papel=mesa (FoodHub). NOT NULL para seller/originador.';
COMMENT ON COLUMN comissoes.comissao_pct          IS 'RN8 — Calculado por B15 com divisão igualitária (100%/50%/33,33%).';
COMMENT ON COLUMN comissoes.comissao_valor_bruto  IS 'R$ bruto preenchido pelo financeiro mensalmente (RN9).';
COMMENT ON COLUMN comissoes.comissao_valor_liquido IS 'R$ após tributo. Camada 1 UX (sempre visível).';
COMMENT ON COLUMN comissoes.composicao_tributos   IS 'JSONB com {iss, pis, cofins, csll, irpj}. Camada 2 UX (pop-up).';
COMMENT ON COLUMN comissoes.periodo_referencia    IS 'YYYY-MM. Indexado quando entra em status fechada_periodo (RN9).';
COMMENT ON COLUMN comissoes.status                IS 'pendente→estruturada→fechada_periodo→paga';

COMMIT;


-- ────────────────────────────────────────────────────────────
-- B12 — CREATE comissoes_periodo (consolidação mensal)
-- Refs: RN9/D25 (Camada 3 UX)
-- Tabela NOVA. 1 linha por (período, player, papel).
-- Financeiro fecha o mês: agrega valores brutos/líquidos/tributos.
-- ROLLBACK: DROP TABLE IF EXISTS comissoes_periodo CASCADE;
-- ────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS comissoes_periodo (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  periodo_referencia    text NOT NULL,
  player_id             uuid REFERENCES players(id) ON DELETE SET NULL,
  papel                 text NOT NULL,
  
  valor_bruto           numeric(12,2) NOT NULL DEFAULT 0,
  valor_liquido         numeric(12,2) NOT NULL DEFAULT 0,
  composicao_tributos   jsonb NOT NULL DEFAULT '{}'::jsonb,
  
  qtd_deals             integer NOT NULL DEFAULT 0,
  observacoes           text,
  
  status                text NOT NULL DEFAULT 'aberto',
  fechado_em            timestamptz,
  fechado_por           uuid REFERENCES players(id),
  
  criado_em             timestamptz NOT NULL DEFAULT now(),
  atualizado_em         timestamptz NOT NULL DEFAULT now(),
  
  UNIQUE (periodo_referencia, player_id, papel)
);

ALTER TABLE comissoes_periodo ADD CONSTRAINT comissoes_periodo_papel_check
  CHECK (papel IN ('mesa','seller','originador'));

ALTER TABLE comissoes_periodo ADD CONSTRAINT comissoes_periodo_status_check
  CHECK (status IN ('aberto','em_fechamento','fechado','pago'));

ALTER TABLE comissoes_periodo ADD CONSTRAINT comissoes_periodo_formato_check
  CHECK (periodo_referencia ~ '^[0-9]{4}-[0-9]{2}$');

ALTER TABLE comissoes_periodo ADD CONSTRAINT comissoes_periodo_player_consistencia_check
  CHECK (
    (papel = 'mesa' AND player_id IS NULL) OR
    (papel IN ('seller','originador') AND player_id IS NOT NULL)
  );

CREATE INDEX idx_comissoes_periodo_periodo  ON comissoes_periodo(periodo_referencia);
CREATE INDEX idx_comissoes_periodo_player   ON comissoes_periodo(player_id) WHERE player_id IS NOT NULL;
CREATE INDEX idx_comissoes_periodo_status   ON comissoes_periodo(status);

-- Liga FK reversa de comissoes → comissoes_periodo
ALTER TABLE comissoes DROP CONSTRAINT IF EXISTS comissoes_periodo_fk;
ALTER TABLE comissoes ADD CONSTRAINT comissoes_periodo_fk
  FOREIGN KEY (comissoes_periodo_id) REFERENCES comissoes_periodo(id) ON DELETE SET NULL;

COMMENT ON TABLE  comissoes_periodo                        IS 'RN9/D25 — Camada 3 UX: consolidação mensal financeira. 1 linha = (período, player, papel).';
COMMENT ON COLUMN comissoes_periodo.periodo_referencia     IS 'YYYY-MM. Indexado por mês.';
COMMENT ON COLUMN comissoes_periodo.valor_bruto            IS 'R$ bruto consolidado do período (soma de comissoes.comissao_valor_bruto).';
COMMENT ON COLUMN comissoes_periodo.valor_liquido          IS 'R$ líquido após tributos.';
COMMENT ON COLUMN comissoes_periodo.composicao_tributos    IS 'JSONB consolidado {iss, pis, cofins, csll, irpj} do período.';
COMMENT ON COLUMN comissoes_periodo.qtd_deals              IS 'Quantos deals contribuíram pra este período.';
COMMENT ON COLUMN comissoes_periodo.status                 IS 'aberto→em_fechamento→fechado→pago. Mensal.';

COMMIT;


-- ────────────────────────────────────────────────────────────
-- B13 — CREATE etapa_sla_padrao + seed 11 etapas
-- Refs: RN3/D30 (SLAs por etapa)
-- Tabela lookup. Seed com 11 etapas do fluxograma operacional.
-- V1: padrão fixo. V2: configurável por deal.
-- ROLLBACK: DROP TABLE IF EXISTS etapa_sla_padrao;
-- ────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS etapa_sla_padrao (
  etapa       smallint PRIMARY KEY CHECK (etapa BETWEEN 1 AND 11),
  nome        text NOT NULL,
  sla_horas   integer NOT NULL CHECK (sla_horas >= 0),
  responsavel text NOT NULL,
  descricao   text NOT NULL
);

ALTER TABLE etapa_sla_padrao DROP CONSTRAINT IF EXISTS etapa_sla_responsavel_check;
ALTER TABLE etapa_sla_padrao ADD CONSTRAINT etapa_sla_responsavel_check
  CHECK (responsavel IN ('cliente','fornecedor','mesa','sistema'));

-- Seed 11 etapas
INSERT INTO etapa_sla_padrao (etapa, nome, sla_horas, responsavel, descricao) VALUES
  (1,  'Deal criado',              0,    'sistema',    'Match feito. Etapa instantânea — registro automático.'),
  (2,  'Termo de acordo',           48,   'mesa',       'Mesa envia termo via ClickSign. 3 assinaturas pendentes.'),
  (3,  'Pedido oficial cliente',    72,   'cliente',    'Cliente emite pedido oficial no ERP.'),
  (4,  'Aceite fornecedor',         24,   'fornecedor', 'Double check: fornecedor confirma pedido recebido.'),
  (5,  'OTIF preparação',           168,  'fornecedor', 'Produção/separação. Default 7 dias (variável por produto).'),
  (6,  'Subir NF',                  24,   'fornecedor', 'NF emitida e subida ao sistema.'),
  (7,  'Confirmação cliente',       120,  'cliente',    'Cliente confirma recebimento e avalia (impacta score).'),
  (8,  'Check liquidação',          168,  'mesa',       'Mesa confirma liquidação da NF junto ao cliente.'),
  (9,  'NF FoodHub emitida',        24,   'mesa',       'Mesa emite NF FoodHub e boleto de comissão.'),
  (10, 'Boleto liquidado',          48,   'fornecedor', 'Fornecedor paga boleto FoodHub.'),
  (11, 'Split repassado',           72,   'mesa',       'Mesa faz repasse aos sellers/originadores.')
ON CONFLICT (etapa) DO UPDATE SET
  nome        = EXCLUDED.nome,
  sla_horas   = EXCLUDED.sla_horas,
  responsavel = EXCLUDED.responsavel,
  descricao   = EXCLUDED.descricao;

COMMENT ON TABLE  etapa_sla_padrao              IS 'RN3/D30 — Lookup das 11 etapas do fluxograma. SLA em horas. V1 fixo, V2 configurável por deal.';
COMMENT ON COLUMN etapa_sla_padrao.sla_horas    IS 'Tempo esperado para conclusão da etapa em horas. 0 = instantâneo.';
COMMENT ON COLUMN etapa_sla_padrao.responsavel  IS 'Quem é responsável por avançar a etapa: cliente | fornecedor | mesa | sistema.';

COMMIT;


-- ────────────────────────────────────────────────────────────
-- B14 — Helpers SQL (5 funções para RLS + lógica)
-- Refs: arquitetura §6.1 + RN4
-- 5 funções públicas usadas por RLS (B19) e triggers.
-- carteira_seller/originador retornam UUID do snapshot (D29).
-- ROLLBACK: DROP FUNCTION ... (5 funções);
-- ────────────────────────────────────────────────────────────

BEGIN;

-- 1. auth_player_id() → uuid do player logado
CREATE OR REPLACE FUNCTION auth_player_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT id FROM public.players WHERE auth_user_id = auth.uid() LIMIT 1;
$$;

-- 2. is_mesa() → boolean (player tem 'mesa' no array tipo)
CREATE OR REPLACE FUNCTION is_mesa()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT COALESCE(
    EXISTS (
      SELECT 1 FROM public.players 
      WHERE auth_user_id = auth.uid() 
        AND 'mesa' = ANY(tipo)
        AND ativo = true
    ),
    false
  );
$$;

-- 3. is_stakeholder_deal(deal_id) → boolean
CREATE OR REPLACE FUNCTION is_stakeholder_deal(p_deal_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.deals d
    WHERE d.id = p_deal_id
      AND (
        d.cliente_id              = auth_player_id() OR
        d.industria_id            = auth_player_id() OR
        d.seller_id_snapshot      = auth_player_id() OR
        d.originador_id_snapshot  = auth_player_id() OR
        is_mesa()
      )
  );
$$;

-- 4. carteira_seller(deal_id) → uuid (RN7/D29)
CREATE OR REPLACE FUNCTION carteira_seller(p_deal_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT seller_id_snapshot FROM public.deals WHERE id = p_deal_id;
$$;

-- 5. carteira_originador(deal_id) → uuid (RN7/D29)
CREATE OR REPLACE FUNCTION carteira_originador(p_deal_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT originador_id_snapshot FROM public.deals WHERE id = p_deal_id;
$$;

-- Permissões: authenticated pode chamar
GRANT EXECUTE ON FUNCTION auth_player_id()                  TO authenticated;
GRANT EXECUTE ON FUNCTION is_mesa()                         TO authenticated;
GRANT EXECUTE ON FUNCTION is_stakeholder_deal(uuid)         TO authenticated;
GRANT EXECUTE ON FUNCTION carteira_seller(uuid)             TO authenticated;
GRANT EXECUTE ON FUNCTION carteira_originador(uuid)         TO authenticated;

COMMENT ON FUNCTION auth_player_id()                  IS 'RN4 — Retorna player_id do usuário logado via auth.uid().';
COMMENT ON FUNCTION is_mesa()                         IS 'RN4 — True se player logado tem tipo mesa e ativo.';
COMMENT ON FUNCTION is_stakeholder_deal(uuid)         IS 'RN4 — True se player logado é parte do deal (cliente/fornecedor/seller/originador/mesa).';
COMMENT ON FUNCTION carteira_seller(uuid)             IS 'RN7/D29 — Lê seller_id_snapshot do deal (não JOIN dinâmico).';
COMMENT ON FUNCTION carteira_originador(uuid)         IS 'RN7/D29 — Lê originador_id_snapshot do deal.';

COMMIT;


-- ────────────────────────────────────────────────────────────
-- B15 — Função calcular_split_comissao(deal_id) [VERSÃO CORRIGIDA]
-- Refs: RN8/D24 + RN7/D22 + D31 (média ponderada por valor SKU)
-- 
-- Lógica:
--   1. Lê snapshots seller_id e originador_id do deal
--   2. Conta papéis presentes (mesa sempre + condicional seller/originador)
--   3. Calcula pct_total = SUM(pct × valor) / SUM(valor) ponderado por SKU
--   4. Divide pct_total em partes iguais (100% / 50/50 / 33,33%)
--   5. INSERT em comissoes (1 linha por papel, ON CONFLICT DO UPDATE)
--   6. Status = 'estruturada' + registra evento
--
-- VERSÃO CORRIGIDA: removido %%% das mensagens RAISE (escape complicado
-- em PL/pgSQL). Usa "por cento" em vez de %.
-- 
-- Chamada por trigger B17 (BEFORE UPDATE termos_acordo='assinado_todos').
-- ROLLBACK: DROP FUNCTION calcular_split_comissao(uuid);
-- ────────────────────────────────────────────────────────────

BEGIN;

CREATE OR REPLACE FUNCTION calcular_split_comissao(p_deal_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_seller_id      uuid;
  v_originador_id  uuid;
  v_n_papeis       smallint := 1; -- mesa sempre
  v_pct_total      numeric(5,4);
  v_valor_total    numeric(12,2);
  v_pct_por_papel  numeric(5,4);
  v_pct_mesa       numeric(5,4);
BEGIN
  -- 1. Lê snapshots do deal (RN7/D29)
  SELECT seller_id_snapshot, originador_id_snapshot
    INTO v_seller_id, v_originador_id
  FROM deals
  WHERE id = p_deal_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'calcular_split_comissao: deal % nao encontrado', p_deal_id;
  END IF;

  -- 2. Conta papéis presentes
  IF v_seller_id IS NOT NULL THEN
    v_n_papeis := v_n_papeis + 1;
  END IF;
  
  IF v_originador_id IS NOT NULL THEN
    v_n_papeis := v_n_papeis + 1;
  END IF;

  -- 3. Calcula pct_total como média ponderada por valor do SKU (D31)
  --    pct = SUM(comissao_pct × valor_total) / SUM(valor_total)
  SELECT 
    COALESCE(
      SUM(dpc.comissao_pct * dp.valor_total) / NULLIF(SUM(dp.valor_total), 0),
      0
    ),
    COALESCE(SUM(dp.valor_total), 0)
  INTO v_pct_total, v_valor_total
  FROM deal_produtos dp
  LEFT JOIN deal_produtos_comissao dpc ON dpc.deal_produto_id = dp.id
  WHERE dp.deal_id = p_deal_id;

  -- Validação Pilar 3 (Ganho Compartilhado)
  IF v_pct_total < 0.005 THEN
    RAISE EXCEPTION 'Pilar 3 violado: comissao global do deal % e %, abaixo do piso 0.005 (0,5 por cento).',
      p_deal_id, v_pct_total;
  END IF;

  -- 4. Divisão igualitária (RN8/D24)
  v_pct_por_papel := ROUND(v_pct_total / v_n_papeis, 4);
  -- Mesa pega o resto pra fechar 100% (compensa arredondamento)
  v_pct_mesa := v_pct_total - (v_pct_por_papel * (v_n_papeis - 1));

  -- 5. INSERT linhas em comissoes (idempotente via ON CONFLICT)
  
  -- Linha mesa (sempre)
  INSERT INTO comissoes (deal_id, papel, player_id, comissao_pct, status)
  VALUES (p_deal_id, 'mesa', NULL, v_pct_mesa, 'estruturada')
  ON CONFLICT (deal_id, papel) DO UPDATE SET
    comissao_pct  = EXCLUDED.comissao_pct,
    status        = 'estruturada',
    atualizado_em = now();

  -- Linha seller (se presente)
  IF v_seller_id IS NOT NULL THEN
    INSERT INTO comissoes (deal_id, papel, player_id, comissao_pct, status)
    VALUES (p_deal_id, 'seller', v_seller_id, v_pct_por_papel, 'estruturada')
    ON CONFLICT (deal_id, papel) DO UPDATE SET
      comissao_pct  = EXCLUDED.comissao_pct,
      player_id     = EXCLUDED.player_id,
      status        = 'estruturada',
      atualizado_em = now();
  END IF;

  -- Linha originador (se presente)
  IF v_originador_id IS NOT NULL THEN
    INSERT INTO comissoes (deal_id, papel, player_id, comissao_pct, status)
    VALUES (p_deal_id, 'originador', v_originador_id, v_pct_por_papel, 'estruturada')
    ON CONFLICT (deal_id, papel) DO UPDATE SET
      comissao_pct  = EXCLUDED.comissao_pct,
      player_id     = EXCLUDED.player_id,
      status        = 'estruturada',
      atualizado_em = now();
  END IF;

  -- 6. Registra evento de auditoria
  INSERT INTO deal_eventos (deal_id, tipo, payload)
  VALUES (
    p_deal_id, 
    'STATUS_ALTERADO', 
    jsonb_build_object(
      'acao',          'calcular_split_comissao',
      'pct_total',     v_pct_total,
      'n_papeis',      v_n_papeis,
      'pct_por_papel', v_pct_por_papel,
      'pct_mesa',      v_pct_mesa,
      'seller_id',     v_seller_id,
      'originador_id', v_originador_id
    )
  );

END;
$$;

GRANT EXECUTE ON FUNCTION calcular_split_comissao(uuid) TO authenticated;

COMMENT ON FUNCTION calcular_split_comissao(uuid) IS 'RN8/D24 — Calcula split igualitário (100/50/33,33%) baseado em snapshots de carteira em deals. Usa média ponderada (D31). Chamado por trigger B17.';

COMMIT;


-- ────────────────────────────────────────────────────────────
-- B16 — Trigger piso 0,5% individual em deal_produtos_comissao
-- Refs: RN1/D28 (piso por SKU)
-- BEFORE INSERT/UPDATE: rejeita pct < 0.005 com mensagem cultural.
-- Pilar 3 (Ganho Compartilhado) protegido por trigger.
-- (CHECK constraint da tabela já protege também — defesa em camadas).
-- ROLLBACK: DROP TRIGGER tg_piso_comissao_individual ON deal_produtos_comissao;
--           DROP FUNCTION fn_validar_piso_comissao_individual();
-- ────────────────────────────────────────────────────────────

BEGIN;

CREATE OR REPLACE FUNCTION fn_validar_piso_comissao_individual()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.comissao_pct < 0.005 THEN
    RAISE EXCEPTION 
      'Pilar 3 violado (Ganho Compartilhado): comissao_pct = % e menor que o piso 0.005 (0,5 por cento). Renegocie ou rejeite o deal.',
      NEW.comissao_pct;
  END IF;

  IF NEW.comissao_pct = 0 THEN
    RAISE EXCEPTION 
      'Comissao zero proibida (Pilar 3 - Na mesa, todos ganham SEMPRE). Use piso minimo 0.005.';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tg_piso_comissao_individual ON deal_produtos_comissao;
CREATE TRIGGER tg_piso_comissao_individual
  BEFORE INSERT OR UPDATE OF comissao_pct ON deal_produtos_comissao
  FOR EACH ROW
  EXECUTE FUNCTION fn_validar_piso_comissao_individual();

COMMENT ON FUNCTION fn_validar_piso_comissao_individual() IS 'RN1/D28 — Trigger BEFORE INSERT/UPDATE: rejeita comissao_pct < 0.005 com mensagem cultural (Pilar 3).';

COMMIT;


-- ────────────────────────────────────────────────────────────
-- B17 — Trigger termos_acordo (auto-avanço + split)
-- Refs: RN3 (etapa 2->3) + RN8/D24 (chama calcular_split)
-- 
-- Quando termos_acordo.status muda para 'assinado_todos':
--   1. Marca timestamp assinado_todos_em
--   2. Avança deals.etapa_atual de 2 para 3
--   3. INSERT deal_eventos TERMO_ASSINADO_TODOS
--   4. Chama calcular_split_comissao (cria linhas em comissoes)
-- 
-- Pilar 2 (Velocidade) + Pilar 6 (Execução) — automação completa.
-- ROLLBACK: DROP TRIGGER tg_termo_assinado_todos ON termos_acordo;
--           DROP FUNCTION fn_termo_assinado_todos();
-- ────────────────────────────────────────────────────────────

BEGIN;

CREATE OR REPLACE FUNCTION fn_termo_assinado_todos()
RETURNS TRIGGER AS $$
BEGIN
  -- Só age quando status muda PARA 'assinado_todos'
  IF NEW.status = 'assinado_todos' AND (OLD.status IS NULL OR OLD.status <> 'assinado_todos') THEN
    
    -- 1. Marca timestamp
    NEW.assinado_todos_em := COALESCE(NEW.assinado_todos_em, now());
    
    -- 2. Avança etapa do deal de 2 para 3 (se etapa atual é 2)
    UPDATE deals
       SET etapa_atual       = 3,
           etapa_iniciada_em = now()
     WHERE id = NEW.deal_id
       AND etapa_atual = 2;
    
    -- 3. Registra evento (Pilar 4 - imutável)
    INSERT INTO deal_eventos (deal_id, tipo, payload)
    VALUES (
      NEW.deal_id,
      'TERMO_ASSINADO_TODOS',
      jsonb_build_object(
        'termo_id',           NEW.id,
        'comissao_pct_global', NEW.comissao_pct_global,
        'assinado_em',        NEW.assinado_todos_em
      )
    );
    
    -- 4. Calcula split de comissões (RN8/D24)
    BEGIN
      PERFORM calcular_split_comissao(NEW.deal_id);
    EXCEPTION WHEN OTHERS THEN
      -- Log do erro mas não bloqueia o termo (split pode ser rodado manualmente)
      INSERT INTO deal_eventos (deal_id, tipo, payload)
      VALUES (
        NEW.deal_id,
        'OBSERVACAO',
        jsonb_build_object(
          'aviso', 'calcular_split_comissao falhou - rodar manualmente',
          'erro',  SQLERRM
        )
      );
    END;
    
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tg_termo_assinado_todos ON termos_acordo;
CREATE TRIGGER tg_termo_assinado_todos
  BEFORE UPDATE OF status ON termos_acordo
  FOR EACH ROW
  EXECUTE FUNCTION fn_termo_assinado_todos();

COMMENT ON FUNCTION fn_termo_assinado_todos() IS 'RN3 + RN8/D24 — Auto-avanca etapa 2->3 e chama calcular_split_comissao quando termo recebe assinatura completa.';

COMMIT;


-- ────────────────────────────────────────────────────────────
-- B18 — Trigger carteira vitalícia + auditoria_carteira
-- Refs: RN7/D22 + D27 (mesa pode reatribuir COM AUDITORIA)
--
-- BEFORE UPDATE em players.seller_id ou players.originador_id:
--   - NULL -> valor: PERMITE (atribuição inicial)
--   - valor -> outro valor: PERMITE SOMENTE se is_mesa() = true
--   - valor -> NULL: REJEITA (carteira não pode ser removida)
--   - Self-reference: REJEITA
--   - Toda alteração registra evento em tabela auditoria_carteira
--
-- ROLLBACK: DROP TRIGGER tg_carteira_vitalicia ON players;
--           DROP FUNCTION fn_carteira_vitalicia();
--           DROP TABLE auditoria_carteira;
-- ────────────────────────────────────────────────────────────

BEGIN;

-- Tabela de auditoria de mudanças de carteira
CREATE TABLE IF NOT EXISTS auditoria_carteira (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id       uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  campo           text NOT NULL,
  valor_anterior  uuid,
  valor_novo      uuid,
  alterado_por    uuid REFERENCES players(id),
  motivo          text,
  alterado_em     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE auditoria_carteira ADD CONSTRAINT auditoria_carteira_campo_check
  CHECK (campo IN ('seller_id','originador_id'));

CREATE INDEX IF NOT EXISTS idx_auditoria_carteira_player ON auditoria_carteira(player_id);
CREATE INDEX IF NOT EXISTS idx_auditoria_carteira_data   ON auditoria_carteira(alterado_em DESC);

-- Trigger imutabilidade da auditoria (igual deal_eventos)
CREATE OR REPLACE FUNCTION fn_auditoria_carteira_imutavel()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'auditoria_carteira eh imutavel (Pilar 4 - Transparencia Radical). UPDATE/DELETE proibido.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tg_auditoria_carteira_no_update ON auditoria_carteira;
CREATE TRIGGER tg_auditoria_carteira_no_update
  BEFORE UPDATE ON auditoria_carteira
  FOR EACH ROW
  EXECUTE FUNCTION fn_auditoria_carteira_imutavel();

DROP TRIGGER IF EXISTS tg_auditoria_carteira_no_delete ON auditoria_carteira;
CREATE TRIGGER tg_auditoria_carteira_no_delete
  BEFORE DELETE ON auditoria_carteira
  FOR EACH ROW
  EXECUTE FUNCTION fn_auditoria_carteira_imutavel();

-- Função principal: trigger carteira vitalícia
CREATE OR REPLACE FUNCTION fn_carteira_vitalicia()
RETURNS TRIGGER AS $$
BEGIN
  -- Self-reference proibido (defesa em camadas — CHECK também tem)
  IF NEW.seller_id IS NOT NULL AND NEW.seller_id = NEW.id THEN
    RAISE EXCEPTION 'Player nao pode ser seller dele mesmo (Pilar 3 - Ganho Compartilhado).';
  END IF;
  
  IF NEW.originador_id IS NOT NULL AND NEW.originador_id = NEW.id THEN
    RAISE EXCEPTION 'Player nao pode ser originador dele mesmo (Pilar 3 - Ganho Compartilhado).';
  END IF;

  -- Mudança em seller_id
  IF OLD.seller_id IS DISTINCT FROM NEW.seller_id THEN
    -- valor -> NULL: REJEITA
    IF OLD.seller_id IS NOT NULL AND NEW.seller_id IS NULL THEN
      RAISE EXCEPTION 'Carteira vitalicia (RN7/D22): seller_id nao pode ser removido. Apenas reatribuido pela mesa.';
    END IF;
    
    -- valor -> outro valor: SO MESA
    IF OLD.seller_id IS NOT NULL AND NEW.seller_id IS NOT NULL AND OLD.seller_id <> NEW.seller_id THEN
      IF NOT is_mesa() THEN
        RAISE EXCEPTION 'Carteira vitalicia (RN7/D22): apenas mesa pode reatribuir seller_id.';
      END IF;
    END IF;
    
    -- Auditoria (qualquer mudanca permitida)
    INSERT INTO auditoria_carteira (player_id, campo, valor_anterior, valor_novo, alterado_por)
    VALUES (NEW.id, 'seller_id', OLD.seller_id, NEW.seller_id, auth_player_id());
  END IF;

  -- Mudança em originador_id (mesma lógica)
  IF OLD.originador_id IS DISTINCT FROM NEW.originador_id THEN
    IF OLD.originador_id IS NOT NULL AND NEW.originador_id IS NULL THEN
      RAISE EXCEPTION 'Carteira vitalicia (RN7/D22): originador_id nao pode ser removido. Apenas reatribuido pela mesa.';
    END IF;
    
    IF OLD.originador_id IS NOT NULL AND NEW.originador_id IS NOT NULL AND OLD.originador_id <> NEW.originador_id THEN
      IF NOT is_mesa() THEN
        RAISE EXCEPTION 'Carteira vitalicia (RN7/D22): apenas mesa pode reatribuir originador_id.';
      END IF;
    END IF;
    
    INSERT INTO auditoria_carteira (player_id, campo, valor_anterior, valor_novo, alterado_por)
    VALUES (NEW.id, 'originador_id', OLD.originador_id, NEW.originador_id, auth_player_id());
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tg_carteira_vitalicia ON players;
CREATE TRIGGER tg_carteira_vitalicia
  BEFORE UPDATE OF seller_id, originador_id ON players
  FOR EACH ROW
  EXECUTE FUNCTION fn_carteira_vitalicia();

COMMENT ON TABLE  auditoria_carteira      IS 'D27 — Auditoria imutavel de mudancas em players.seller_id/originador_id.';
COMMENT ON FUNCTION fn_carteira_vitalicia() IS 'RN7/D22/D27 — Protege carteira vitalicia: NULL->valor (qualquer um), valor->outro (so mesa), valor->NULL (proibido).';

COMMIT;


-- ════════════════════════════════════════════════════════════
-- B19 — RLS em 15 tabelas (52 policies, dividido em 5 sub-blocos)
-- Refs: arquitetura §6 + RN4/D21
-- 
-- Estratégia: ENABLE RLS + CREATE POLICY por (tabela, role).
-- Helpers (B14): auth_player_id(), is_mesa(), is_stakeholder_deal()
-- 
-- Sub-blocos:
--   B19a — players, oportunidades, propostas_v3 (12 policies)
--   B19b — deals, deal_produtos, deal_produtos_comissao (12 policies)
--   B19c — comissoes, comissoes_periodo, deal_eventos (10 policies)
--   B19d — termos_acordo, oportunidade_convites, comunicacoes (12 policies)
--   B19e — nf_uploads, etapa_sla_padrao, auditoria_carteira (8 policies)
-- 
-- Total: 52 policies em 15 tabelas. Q1 confirmou greenfield.
-- ROLLBACK por sub-bloco: DROP POLICY ... + ALTER TABLE ... DISABLE RLS.
-- ════════════════════════════════════════════════════════════


-- ────────────────────────────────────────────────────────────
-- B19a — RLS em players + oportunidades + propostas_v3
-- ────────────────────────────────────────────────────────────

BEGIN;

-- TABELA 1: players
ALTER TABLE players ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS players_select_self_or_active ON players;
CREATE POLICY players_select_self_or_active ON players
  FOR SELECT TO authenticated
  USING (
    is_mesa() 
    OR auth_user_id = auth.uid()
    OR ativo = true
  );

DROP POLICY IF EXISTS players_insert_mesa ON players;
CREATE POLICY players_insert_mesa ON players
  FOR INSERT TO authenticated
  WITH CHECK (is_mesa());

DROP POLICY IF EXISTS players_update_self_or_mesa ON players;
CREATE POLICY players_update_self_or_mesa ON players
  FOR UPDATE TO authenticated
  USING (is_mesa() OR auth_user_id = auth.uid())
  WITH CHECK (is_mesa() OR auth_user_id = auth.uid());

DROP POLICY IF EXISTS players_delete_mesa ON players;
CREATE POLICY players_delete_mesa ON players
  FOR DELETE TO authenticated
  USING (is_mesa());

-- TABELA 2: oportunidades
ALTER TABLE oportunidades ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS oportunidades_select ON oportunidades;
CREATE POLICY oportunidades_select ON oportunidades
  FOR SELECT TO authenticated
  USING (
    is_mesa()
    OR cliente_id = auth_player_id()
    OR EXISTS (
      SELECT 1 FROM oportunidade_convites oc
      WHERE oc.oportunidade_id = oportunidades.id
        AND oc.industria_id = auth_player_id()
    )
  );

DROP POLICY IF EXISTS oportunidades_insert_cliente_ou_mesa ON oportunidades;
CREATE POLICY oportunidades_insert_cliente_ou_mesa ON oportunidades
  FOR INSERT TO authenticated
  WITH CHECK (
    is_mesa() 
    OR cliente_id = auth_player_id()
  );

DROP POLICY IF EXISTS oportunidades_update_mesa_ou_cliente ON oportunidades;
CREATE POLICY oportunidades_update_mesa_ou_cliente ON oportunidades
  FOR UPDATE TO authenticated
  USING (
    is_mesa() 
    OR (cliente_id = auth_player_id() AND status_cliente = 'pendente')
  )
  WITH CHECK (
    is_mesa() 
    OR (cliente_id = auth_player_id() AND status_cliente = 'pendente')
  );

DROP POLICY IF EXISTS oportunidades_delete_mesa ON oportunidades;
CREATE POLICY oportunidades_delete_mesa ON oportunidades
  FOR DELETE TO authenticated
  USING (is_mesa());

-- TABELA 3: propostas_v3
ALTER TABLE propostas_v3 ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS propostas_select ON propostas_v3;
CREATE POLICY propostas_select ON propostas_v3
  FOR SELECT TO authenticated
  USING (
    is_mesa()
    OR industria_id = auth_player_id()
    OR EXISTS (
      SELECT 1 FROM oportunidades o
      WHERE o.id = propostas_v3.oportunidade_id
        AND o.cliente_id = auth_player_id()
    )
  );

DROP POLICY IF EXISTS propostas_insert_industria ON propostas_v3;
CREATE POLICY propostas_insert_industria ON propostas_v3
  FOR INSERT TO authenticated
  WITH CHECK (
    is_mesa() 
    OR industria_id = auth_player_id()
  );

DROP POLICY IF EXISTS propostas_update_industria_ou_mesa ON propostas_v3;
CREATE POLICY propostas_update_industria_ou_mesa ON propostas_v3
  FOR UPDATE TO authenticated
  USING (
    is_mesa() 
    OR (industria_id = auth_player_id() AND status = 'enviada')
  )
  WITH CHECK (
    is_mesa() 
    OR (industria_id = auth_player_id() AND status = 'enviada')
  );

DROP POLICY IF EXISTS propostas_delete_mesa ON propostas_v3;
CREATE POLICY propostas_delete_mesa ON propostas_v3
  FOR DELETE TO authenticated
  USING (is_mesa());

COMMIT;


-- ────────────────────────────────────────────────────────────
-- B19b — RLS em deals + deal_produtos + deal_produtos_comissao
-- D21: Seller e Originador VEEM ciclo completo de seus deals
-- ────────────────────────────────────────────────────────────

BEGIN;

-- TABELA 4: deals
ALTER TABLE deals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS deals_select ON deals;
CREATE POLICY deals_select ON deals
  FOR SELECT TO authenticated
  USING (
    is_mesa()
    OR cliente_id              = auth_player_id()
    OR industria_id            = auth_player_id()
    OR seller_id_snapshot      = auth_player_id()
    OR originador_id_snapshot  = auth_player_id()
  );

DROP POLICY IF EXISTS deals_insert_mesa ON deals;
CREATE POLICY deals_insert_mesa ON deals
  FOR INSERT TO authenticated
  WITH CHECK (is_mesa());

DROP POLICY IF EXISTS deals_update_mesa ON deals;
CREATE POLICY deals_update_mesa ON deals
  FOR UPDATE TO authenticated
  USING (is_mesa())
  WITH CHECK (is_mesa());

DROP POLICY IF EXISTS deals_delete_mesa ON deals;
CREATE POLICY deals_delete_mesa ON deals
  FOR DELETE TO authenticated
  USING (is_mesa());

-- TABELA 5: deal_produtos
ALTER TABLE deal_produtos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS deal_produtos_select ON deal_produtos;
CREATE POLICY deal_produtos_select ON deal_produtos
  FOR SELECT TO authenticated
  USING (is_stakeholder_deal(deal_id));

DROP POLICY IF EXISTS deal_produtos_insert_mesa ON deal_produtos;
CREATE POLICY deal_produtos_insert_mesa ON deal_produtos
  FOR INSERT TO authenticated
  WITH CHECK (is_mesa());

DROP POLICY IF EXISTS deal_produtos_update_mesa ON deal_produtos;
CREATE POLICY deal_produtos_update_mesa ON deal_produtos
  FOR UPDATE TO authenticated
  USING (is_mesa())
  WITH CHECK (is_mesa());

DROP POLICY IF EXISTS deal_produtos_delete_mesa ON deal_produtos;
CREATE POLICY deal_produtos_delete_mesa ON deal_produtos
  FOR DELETE TO authenticated
  USING (is_mesa());

-- TABELA 6: deal_produtos_comissao
ALTER TABLE deal_produtos_comissao ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS deal_produtos_comissao_select ON deal_produtos_comissao;
CREATE POLICY deal_produtos_comissao_select ON deal_produtos_comissao
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM deal_produtos dp
      WHERE dp.id = deal_produtos_comissao.deal_produto_id
        AND is_stakeholder_deal(dp.deal_id)
    )
  );

DROP POLICY IF EXISTS deal_produtos_comissao_insert_mesa ON deal_produtos_comissao;
CREATE POLICY deal_produtos_comissao_insert_mesa ON deal_produtos_comissao
  FOR INSERT TO authenticated
  WITH CHECK (is_mesa());

DROP POLICY IF EXISTS deal_produtos_comissao_update_mesa ON deal_produtos_comissao;
CREATE POLICY deal_produtos_comissao_update_mesa ON deal_produtos_comissao
  FOR UPDATE TO authenticated
  USING (is_mesa())
  WITH CHECK (is_mesa());

DROP POLICY IF EXISTS deal_produtos_comissao_delete_mesa ON deal_produtos_comissao;
CREATE POLICY deal_produtos_comissao_delete_mesa ON deal_produtos_comissao
  FOR DELETE TO authenticated
  USING (is_mesa());

COMMIT;


-- ────────────────────────────────────────────────────────────
-- B19c — RLS em comissoes + comissoes_periodo + deal_eventos
-- ★ MAIS DELICADO: protege visibilidade de comissões (RN4/D21)
-- D21: Seller/Originador VEEM SUA OWN linha em comissoes
-- Cliente/Fornecedor: NUNCA veem comissoes
-- ────────────────────────────────────────────────────────────

BEGIN;

-- TABELA 7: comissoes ★ CRÍTICA
ALTER TABLE comissoes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS comissoes_select ON comissoes;
CREATE POLICY comissoes_select ON comissoes
  FOR SELECT TO authenticated
  USING (
    is_mesa()
    OR (papel = 'seller'     AND player_id = auth_player_id())
    OR (papel = 'originador' AND player_id = auth_player_id())
  );

DROP POLICY IF EXISTS comissoes_insert_mesa ON comissoes;
CREATE POLICY comissoes_insert_mesa ON comissoes
  FOR INSERT TO authenticated
  WITH CHECK (is_mesa());

DROP POLICY IF EXISTS comissoes_update_mesa ON comissoes;
CREATE POLICY comissoes_update_mesa ON comissoes
  FOR UPDATE TO authenticated
  USING (is_mesa())
  WITH CHECK (is_mesa());

DROP POLICY IF EXISTS comissoes_delete_mesa ON comissoes;
CREATE POLICY comissoes_delete_mesa ON comissoes
  FOR DELETE TO authenticated
  USING (is_mesa());

-- TABELA 8: comissoes_periodo
ALTER TABLE comissoes_periodo ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS comissoes_periodo_select ON comissoes_periodo;
CREATE POLICY comissoes_periodo_select ON comissoes_periodo
  FOR SELECT TO authenticated
  USING (
    is_mesa()
    OR (papel = 'seller'     AND player_id = auth_player_id())
    OR (papel = 'originador' AND player_id = auth_player_id())
  );

DROP POLICY IF EXISTS comissoes_periodo_insert_mesa ON comissoes_periodo;
CREATE POLICY comissoes_periodo_insert_mesa ON comissoes_periodo
  FOR INSERT TO authenticated
  WITH CHECK (is_mesa());

DROP POLICY IF EXISTS comissoes_periodo_update_mesa ON comissoes_periodo;
CREATE POLICY comissoes_periodo_update_mesa ON comissoes_periodo
  FOR UPDATE TO authenticated
  USING (is_mesa())
  WITH CHECK (is_mesa());

DROP POLICY IF EXISTS comissoes_periodo_delete_mesa ON comissoes_periodo;
CREATE POLICY comissoes_periodo_delete_mesa ON comissoes_periodo
  FOR DELETE TO authenticated
  USING (is_mesa());

-- TABELA 9: deal_eventos
-- Stakeholders do deal veem eventos do deal (D21 - histórico)
-- UPDATE/DELETE bloqueado por trigger imutabilidade (B08)
ALTER TABLE deal_eventos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS deal_eventos_select ON deal_eventos;
CREATE POLICY deal_eventos_select ON deal_eventos
  FOR SELECT TO authenticated
  USING (is_stakeholder_deal(deal_id));

DROP POLICY IF EXISTS deal_eventos_insert_mesa ON deal_eventos;
CREATE POLICY deal_eventos_insert_mesa ON deal_eventos
  FOR INSERT TO authenticated
  WITH CHECK (
    is_mesa() 
    OR is_stakeholder_deal(deal_id)
  );

COMMIT;


-- ────────────────────────────────────────────────────────────
-- B19d — RLS em termos_acordo + oportunidade_convites + comunicacoes
-- ────────────────────────────────────────────────────────────

BEGIN;

-- TABELA 10: termos_acordo
ALTER TABLE termos_acordo ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS termos_acordo_select ON termos_acordo;
CREATE POLICY termos_acordo_select ON termos_acordo
  FOR SELECT TO authenticated
  USING (is_stakeholder_deal(deal_id));

DROP POLICY IF EXISTS termos_acordo_insert_mesa ON termos_acordo;
CREATE POLICY termos_acordo_insert_mesa ON termos_acordo
  FOR INSERT TO authenticated
  WITH CHECK (is_mesa());

DROP POLICY IF EXISTS termos_acordo_update_mesa ON termos_acordo;
CREATE POLICY termos_acordo_update_mesa ON termos_acordo
  FOR UPDATE TO authenticated
  USING (is_mesa())
  WITH CHECK (is_mesa());

DROP POLICY IF EXISTS termos_acordo_delete_mesa ON termos_acordo;
CREATE POLICY termos_acordo_delete_mesa ON termos_acordo
  FOR DELETE TO authenticated
  USING (is_mesa());

-- TABELA 11: oportunidade_convites
ALTER TABLE oportunidade_convites ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS oportunidade_convites_select ON oportunidade_convites;
CREATE POLICY oportunidade_convites_select ON oportunidade_convites
  FOR SELECT TO authenticated
  USING (
    is_mesa()
    OR industria_id = auth_player_id()
    OR EXISTS (
      SELECT 1 FROM oportunidades o
      WHERE o.id = oportunidade_convites.oportunidade_id
        AND o.cliente_id = auth_player_id()
    )
  );

DROP POLICY IF EXISTS oportunidade_convites_insert_mesa ON oportunidade_convites;
CREATE POLICY oportunidade_convites_insert_mesa ON oportunidade_convites
  FOR INSERT TO authenticated
  WITH CHECK (is_mesa());

DROP POLICY IF EXISTS oportunidade_convites_update ON oportunidade_convites;
CREATE POLICY oportunidade_convites_update ON oportunidade_convites
  FOR UPDATE TO authenticated
  USING (
    is_mesa()
    OR industria_id = auth_player_id()
  )
  WITH CHECK (
    is_mesa()
    OR industria_id = auth_player_id()
  );

DROP POLICY IF EXISTS oportunidade_convites_delete_mesa ON oportunidade_convites;
CREATE POLICY oportunidade_convites_delete_mesa ON oportunidade_convites
  FOR DELETE TO authenticated
  USING (is_mesa());

-- TABELA 12: comunicacoes
ALTER TABLE comunicacoes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS comunicacoes_select ON comunicacoes;
CREATE POLICY comunicacoes_select ON comunicacoes
  FOR SELECT TO authenticated
  USING (
    is_mesa()
    OR destinatario_id = auth_player_id()
  );

DROP POLICY IF EXISTS comunicacoes_insert_mesa ON comunicacoes;
CREATE POLICY comunicacoes_insert_mesa ON comunicacoes
  FOR INSERT TO authenticated
  WITH CHECK (is_mesa());

DROP POLICY IF EXISTS comunicacoes_update_mesa ON comunicacoes;
CREATE POLICY comunicacoes_update_mesa ON comunicacoes
  FOR UPDATE TO authenticated
  USING (is_mesa())
  WITH CHECK (is_mesa());

DROP POLICY IF EXISTS comunicacoes_delete_mesa ON comunicacoes;
CREATE POLICY comunicacoes_delete_mesa ON comunicacoes
  FOR DELETE TO authenticated
  USING (is_mesa());

COMMIT;


-- ────────────────────────────────────────────────────────────
-- B19e — RLS em nf_uploads + etapa_sla_padrao + auditoria_carteira
-- ────────────────────────────────────────────────────────────

BEGIN;

-- TABELA 13: nf_uploads
ALTER TABLE nf_uploads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS nf_uploads_select ON nf_uploads;
CREATE POLICY nf_uploads_select ON nf_uploads
  FOR SELECT TO authenticated
  USING (is_stakeholder_deal(deal_id));

DROP POLICY IF EXISTS nf_uploads_insert ON nf_uploads;
CREATE POLICY nf_uploads_insert ON nf_uploads
  FOR INSERT TO authenticated
  WITH CHECK (
    is_mesa()
    OR EXISTS (
      SELECT 1 FROM deals d
      WHERE d.id = nf_uploads.deal_id
        AND d.industria_id = auth_player_id()
    )
  );

DROP POLICY IF EXISTS nf_uploads_update_mesa ON nf_uploads;
CREATE POLICY nf_uploads_update_mesa ON nf_uploads
  FOR UPDATE TO authenticated
  USING (is_mesa())
  WITH CHECK (is_mesa());

DROP POLICY IF EXISTS nf_uploads_delete_mesa ON nf_uploads;
CREATE POLICY nf_uploads_delete_mesa ON nf_uploads
  FOR DELETE TO authenticated
  USING (is_mesa());

-- TABELA 14: etapa_sla_padrao (lookup)
ALTER TABLE etapa_sla_padrao ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS etapa_sla_padrao_select ON etapa_sla_padrao;
CREATE POLICY etapa_sla_padrao_select ON etapa_sla_padrao
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS etapa_sla_padrao_write_mesa ON etapa_sla_padrao;
CREATE POLICY etapa_sla_padrao_write_mesa ON etapa_sla_padrao
  FOR ALL TO authenticated
  USING (is_mesa())
  WITH CHECK (is_mesa());

-- TABELA 15: auditoria_carteira (D27 - imutável)
ALTER TABLE auditoria_carteira ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS auditoria_carteira_select ON auditoria_carteira;
CREATE POLICY auditoria_carteira_select ON auditoria_carteira
  FOR SELECT TO authenticated
  USING (
    is_mesa()
    OR player_id = auth_player_id()
  );

DROP POLICY IF EXISTS auditoria_carteira_insert_mesa ON auditoria_carteira;
CREATE POLICY auditoria_carteira_insert_mesa ON auditoria_carteira
  FOR INSERT TO authenticated
  WITH CHECK (is_mesa());

-- UPDATE/DELETE bloqueados via trigger imutabilidade (B18)

COMMIT;


-- ════════════════════════════════════════════════════════════
-- B20 — Smoke test (Bloco F — validação)
-- 
-- NOTA: Este bloco contém apenas queries SELECT/asserções de
-- validação que foram executadas APENAS NO DASHBOARD em 27/04/2026.
-- 
-- NÃO é incluído neste arquivo de migration porque não altera
-- schema. As validações abaixo estão documentadas em
-- docs/diagnostico-banco-pre-s2.md §12.
-- 
-- Validações executadas:
--   1. RLS ativo em 15 tabelas → 15 OK
--   2. 6 funções SQL existem → confirmado
--   3. 8 triggers críticos ativos → confirmado
--   4. etapa_sla_padrao com 11 linhas → confirmado
--   5. comissoes com 17 colunas (linha-por-papel) → confirmado
--   6. 52 policies RLS distribuídas → confirmado
--   7. CHECK piso 0,5% em deal_produtos_comissao → ativo
--   8. CHECK self-reference em players → ativo (seller + originador)
-- 
-- ════════════════════════════════════════════════════════════


-- ============================================================
-- FIM DA MIGRATION 009 — S2 MESA CONCIERGE V1
-- ============================================================
-- Próximas sessões:
--   S3 (terça 28/abr) — RPC propostas + score 60/15/10/15 (RN2)
--   S4 (quarta)       — ClickSign + Resend Edge Functions
--   S5 (quinta)       — Smoke test fim a fim
--   1/maio (sexta)    — Mesa Concierge V1 ESTREIA 🎯
-- ============================================================