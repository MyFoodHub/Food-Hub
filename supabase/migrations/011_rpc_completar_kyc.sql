-- ============================================================
-- 011_rpc_completar_kyc.sql
-- Sessão 3 — Bloco B.3: RPC de finalização do KYC (CNPJ + WhatsApp)
-- Data: 2026-04-28 | CEO: Humberto Abílio | Co: Samanta Marçal
-- ============================================================
-- Decisão D38 (28/abr): KYC submit via RPC SECURITY DEFINER (mesmo
--   padrão da 010). Cliente anon NÃO escreve em players direto.
-- Decisão D43 (28/abr): KYC V1 = só CNPJ + WhatsApp + clique. Senha
--   vem em S4 com Resend. Sem password aqui.
--
-- Pré-req: 010 aplicado (validar_convite_token). Player precisa estar
--   em 'convidado' ou 'kyc_iniciado' para completar KYC.
--
-- Apply: copiar+colar no Dashboard SQL Editor.
-- Idempotência: NÃO é idempotente em sucesso — uma vez kyc_completo,
--   re-submeter falha com mensagem clara. DROP+CREATE OR REPLACE é
--   idempotente na criação da função.
-- Concorrência: SELECT ... FOR UPDATE serializa requests duplicados
--   (botão "Confirmar" clicado 2x). Segunda request bloqueia, depois
--   re-checa status e cai em 'KYC já completo'.
-- Transação: BEGIN/COMMIT — smoke test falhar faz ROLLBACK tudo.
--
-- Comportamento de public.completar_kyc(p_token, p_cnpj, p_whatsapp) RETURNS jsonb:
--   - p_cnpj sanitizado != 14 dígitos      → EXCEPTION 'CNPJ inválido...'
--   - p_whatsapp sanitizado fora 10-13     → EXCEPTION 'WhatsApp inválido...'
--   - 12-13 dígitos sem prefixo '55'       → EXCEPTION 'WhatsApp inválido...'
--   - Token inexistente                    → EXCEPTION 'Token inválido ou expirado'
--   - status='bloqueado'                   → EXCEPTION 'Player bloqueado'
--   - status='ativo'                       → EXCEPTION 'Cadastro já completo, faça login'
--   - status='kyc_completo'                → EXCEPTION 'KYC já completo. Aguarde aprovação da mesa.'
--   - status='convidado' OU 'kyc_iniciado' → UPDATE → 'kyc_completo', retorna jsonb
--   - cnpj duplicado (unique_violation)    → EXCEPTION 'CNPJ já cadastrado para outro player'
--
-- jsonb retornado: { id, razao_social, email, onboarding_status, cnpj, whatsapp }
--
-- ROLLBACK: DROP FUNCTION public.completar_kyc(text, text, text);
-- ============================================================


-- ────────────────────────────────────────────────────────────
-- B.3 — RPC completar_kyc
-- Refs: D38 + D43 (28/abr) + arquitetura §3.1
-- ────────────────────────────────────────────────────────────

BEGIN;

DROP FUNCTION IF EXISTS public.completar_kyc(text, text, text);

CREATE OR REPLACE FUNCTION public.completar_kyc(
  p_token    text,
  p_cnpj     text,
  p_whatsapp text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_player     public.players%ROWTYPE;
  v_cnpj_clean text;
  v_wa_clean   text;
BEGIN
  -- 1. Sanitiza inputs server-side (não confia no front)
  v_cnpj_clean := regexp_replace(COALESCE(p_cnpj, ''),     '[^0-9]', '', 'g');
  v_wa_clean   := regexp_replace(COALESCE(p_whatsapp, ''), '[^0-9]', '', 'g');

  -- 2. Valida CNPJ: exatamente 14 dígitos (sem mod-10, mesa valida em F2)
  IF length(v_cnpj_clean) <> 14 THEN
    RAISE EXCEPTION 'CNPJ inválido: deve conter 14 dígitos';
  END IF;

  -- 3. Valida WhatsApp: 10-13 dígitos. 12-13 exigem prefixo '55'.
  IF length(v_wa_clean) < 10 OR length(v_wa_clean) > 13 THEN
    RAISE EXCEPTION 'WhatsApp inválido: deve conter 10 a 13 dígitos';
  END IF;
  IF length(v_wa_clean) IN (12, 13) AND left(v_wa_clean, 2) <> '55' THEN
    RAISE EXCEPTION 'WhatsApp inválido: 12-13 dígitos exigem prefixo 55';
  END IF;

  -- 4. Busca player por token, com lock (serializa double-submit)
  SELECT * INTO v_player
  FROM public.players
  WHERE convite_token = p_token
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Token inválido ou expirado';
  END IF;

  -- 5. Validação de estado (transições permitidas)
  IF v_player.onboarding_status = 'bloqueado' THEN
    RAISE EXCEPTION 'Player bloqueado';
  END IF;
  IF v_player.onboarding_status = 'ativo' THEN
    RAISE EXCEPTION 'Cadastro já completo, faça login';
  END IF;
  IF v_player.onboarding_status = 'kyc_completo' THEN
    RAISE EXCEPTION 'KYC já completo. Aguarde aprovação da mesa.';
  END IF;
  IF v_player.onboarding_status NOT IN ('convidado', 'kyc_iniciado') THEN
    RAISE EXCEPTION 'Status inesperado: %', v_player.onboarding_status;
  END IF;

  -- 6. UPDATE atomic. Trata duplicidade de CNPJ se existir UNIQUE constraint
  --    (schema atual nao tem, mas defensivo pra evolucao do schema).
  BEGIN
    UPDATE public.players
       SET cnpj              = v_cnpj_clean,
           whatsapp          = v_wa_clean,
           onboarding_status = 'kyc_completo'
     WHERE id = v_player.id;
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION 'CNPJ já cadastrado para outro player';
  END;

  -- 7. Retorna estado pós-update
  RETURN jsonb_build_object(
    'id',                v_player.id,
    'razao_social',      v_player.razao_social,
    'email',             v_player.email,
    'onboarding_status', 'kyc_completo',
    'cnpj',              v_cnpj_clean,
    'whatsapp',          v_wa_clean
  );
END;
$$;

-- Permissões: anon (landing pública chama com anon key), authenticated, service_role.
REVOKE EXECUTE ON FUNCTION public.completar_kyc(text, text, text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.completar_kyc(text, text, text) TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.completar_kyc(text, text, text) IS
  'D38 / D43 / S3 Bloco B.3 — Conclui KYC do convite (CNPJ + WhatsApp). Sanitiza inputs server-side. Avança onboarding_status convidado/kyc_iniciado → kyc_completo. SELECT FOR UPDATE serializa double-submit. Trata duplicidade de CNPJ via unique_violation. SECURITY DEFINER porque cliente anon não escreve em players direto.';


-- ────────────────────────────────────────────────────────────
-- Smoke test idempotente: token inexistente deve levantar
-- 'Token inválido ou expirado'. NÃO testa caso de sucesso —
-- corromperia player de teste. CNPJ/WhatsApp do smoke passam
-- na validação de formato pra reach o passo de token lookup.
-- ────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_result jsonb;
BEGIN
  BEGIN
    v_result := public.completar_kyc(
      '__TESTE_INEXISTENTE_S3_BLOCO_B3__',
      '00000000000000',
      '5511999999999'
    );
    RAISE EXCEPTION 'SMOKE FALHOU: token inexistente deveria ter levantado excecao mas retornou %', v_result;
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM = 'Token inválido ou expirado' THEN
        RAISE NOTICE 'SMOKE OK: token inexistente levanta excecao correta.';
      ELSE
        RAISE EXCEPTION 'SMOKE FALHOU: excecao inesperada: %', SQLERRM;
      END IF;
  END;
END
$$;

COMMIT;
