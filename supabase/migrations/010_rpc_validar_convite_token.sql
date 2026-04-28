-- ============================================================
-- 010_rpc_validar_convite_token.sql
-- Sessão 3 — Bloco B.1: RPC de validação do convite (landing pública)
-- Data: 2026-04-28 | CEO: Humberto Abílio | Co: Samanta Marçal
-- ============================================================
-- Decisão D38 (28/abr): validação do convite acontece via RPC com
--   SECURITY DEFINER. Cliente anon NÃO pode SELECT direto em players
--   (RLS bloqueia). RPC roda como owner e retorna apenas os campos
--   permitidos pra landing.
--
-- Pré-req: 009_mesa_concierge_v1.sql aplicado (D35/D36 — tipo text[],
--   onboarding_status NOT NULL DEFAULT 'convidado' CHECK convidado/
--   kyc_iniciado/kyc_completo/ativo/bloqueado).
--
-- Apply: copiar+colar no Dashboard SQL Editor (Supabase).
--        NÃO rodar `supabase db push` daqui.
-- Idempotência: DROP IF EXISTS + CREATE OR REPLACE — rodar 2x é no-op.
-- Transação: BEGIN/COMMIT — smoke test falhar faz ROLLBACK tudo.
--
-- Comportamento de public.validar_convite_token(p_token text) RETURNS jsonb:
--   - Token inexistente              → EXCEPTION 'Token inválido ou expirado'
--   - onboarding_status='bloqueado'  → EXCEPTION 'Player bloqueado'
--   - onboarding_status='ativo'      → EXCEPTION 'Cadastro já completo, faça login'
--   - onboarding_status='convidado'  → UPDATE → 'kyc_iniciado', retorna jsonb
--   - onboarding_status='kyc_iniciado'/'kyc_completo'
--                                    → preserva status, retorna jsonb
--                                      (player retoma fluxo onde parou; D37 inspira)
--
-- jsonb retornado: { id, razao_social, email, contato_nome, tipo, onboarding_status }
--
-- ROLLBACK: DROP FUNCTION public.validar_convite_token(text);
-- ============================================================


-- ────────────────────────────────────────────────────────────
-- B.1 — RPC validar_convite_token
-- Refs: D38 (28/abr) + arquitetura §3.1 (auth players)
-- ────────────────────────────────────────────────────────────

BEGIN;

DROP FUNCTION IF EXISTS public.validar_convite_token(text);

CREATE OR REPLACE FUNCTION public.validar_convite_token(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_player public.players%ROWTYPE;
  v_status text;
BEGIN
  -- 1. Busca player por convite_token
  SELECT * INTO v_player
  FROM public.players
  WHERE convite_token = p_token
  LIMIT 1;

  -- 2. Token não encontrado
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Token inválido ou expirado';
  END IF;

  -- 3. Player bloqueado
  IF v_player.onboarding_status = 'bloqueado' THEN
    RAISE EXCEPTION 'Player bloqueado';
  END IF;

  -- 4. Player com cadastro completo
  IF v_player.onboarding_status = 'ativo' THEN
    RAISE EXCEPTION 'Cadastro já completo, faça login';
  END IF;

  -- 5. Avança status: convidado → kyc_iniciado.
  --    kyc_iniciado / kyc_completo: preserva (retoma fluxo onde parou).
  IF v_player.onboarding_status = 'convidado' THEN
    UPDATE public.players
       SET onboarding_status = 'kyc_iniciado'
     WHERE id = v_player.id;
    v_status := 'kyc_iniciado';
  ELSE
    v_status := v_player.onboarding_status;
  END IF;

  -- 6. Retorna dados do player (com status atualizado)
  RETURN jsonb_build_object(
    'id',                v_player.id,
    'razao_social',      v_player.razao_social,
    'email',             v_player.email,
    'contato_nome',      v_player.contato_nome,
    'tipo',              v_player.tipo,
    'onboarding_status', v_status
  );
END;
$$;

-- Permissões: anon (landing pública), authenticated, service_role.
-- REVOKE FROM PUBLIC fecha o default GRANT que CREATE FUNCTION dá.
REVOKE EXECUTE ON FUNCTION public.validar_convite_token(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.validar_convite_token(text) TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.validar_convite_token(text) IS
  'D38 / S3 Bloco B.1 — Valida convite_token e avança onboarding_status (convidado→kyc_iniciado). Levanta exceção para token inexistente, player bloqueado ou cadastro já completo. SECURITY DEFINER porque cliente anon não pode SELECT direto em players.';


-- ────────────────────────────────────────────────────────────
-- Smoke test idempotente: token inexistente deve levantar
-- 'Token inválido ou expirado'. Qualquer outro comportamento
-- (retorno OK, exceção diferente, etc.) → RAISE EXCEPTION
-- propaga e ROLLBACK desfaz toda a migration.
-- ────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_result jsonb;
BEGIN
  BEGIN
    v_result := public.validar_convite_token('__TESTE_INEXISTENTE_S3_BLOCO_B__');
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
