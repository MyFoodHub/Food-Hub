# Diagnóstico do banco — pré-S2

**Versão:** 1.0
**Data:** 26 de abril de 2026 (sessão bônus de domingo, READ-ONLY)
**Sessão de origem:** Sessão Bônus — investigação do estado real do banco antes da escrita da migration `009_mesa_concierge_v1.sql` (S2 — segunda 27/abr).
**Modo de execução:** Apenas SELECT (`information_schema`, `pg_*` quando possível) e leitura de arquivos. Zero DDL, zero DML, zero migration nova nesta sessão.
**Probe:** `scripts/_probe_readonly.js` (gitignored, prefix `_`).

> Documento de **diagnóstico**. Atualiza/complementa `docs/arquitetura-mesa-concierge-v1.md`. Mudanças no plano da S2 estão na §8.

---

## 1. Resumo executivo

- **16 colunas a CRIAR** nas tabelas-alvo da S2 (7 em `players` + 4 em `oportunidades` + 2 em `propostas_v3` + 3 em `deals`). **Nenhuma já existe** — plano §10 da arquitetura está integral.
- **4 das 7 tabelas-alvo estão zeradas** (`propostas_v3`, `deal_produtos`, `nf_uploads`, `comissoes`). Backfill `deal_produtos.comissao_*` → `deal_produtos_comissao` é **NO-OP** (0 linhas).
- **RLS habilitada nas 7 tabelas-alvo** (declarada em migrations 004/006/007), mas **ZERO policies** nelas — são GREENFIELD (Q1 confirmou em 26/04/2026). Policies do Dashboard existem só nas ~12 tabelas legado do front V0 (`demandas`, `mensagens`, `propostas`, `negociacoes`, …) e seguem padrão simples `auth.uid() = user_id` (Q2). **A 009 cria RLS pela primeira vez** nas 7 alvo + 5 novas — não há reescrita, só CREATE. Smoke test S5 valida estreia da arquitetura multi-papel V1.
- **8 tabelas legado mapeadas** (BLOCO B + `members`): `aprovacoes`, `demandas`, `mensagens`, `negociacoes` (pares v1) + suas v2 + `members`. **Nenhuma tocada na S2.** Apenas `aprovacoes_v2` aparenta seguir viva — investigação na S3.
- **7 Edge Functions existentes**, todas do FoodHub V3 (pré-V1). 5 são legado V0 sem gatilho ativo (WhatsApp inativo). 1 (`email-agent`) é base pra refator em S4. 3 funções a criar em S4 (clicksign-enviar, clicksign-webhook, enviar-email).
- **0 Storage buckets** configurados. `termos` e `nfs` (privados) a criar **manualmente no Dashboard durante a S4**.

---

## 2. Tabelas-alvo da S2 — estado atual

### 2.1 Colunas a criar (16 total)

| Tabela | Linhas | Colunas a criar | Estado |
|---|---|---|---|
| `players` | 43 | `auth_user_id`, `ativo`, `bloqueado_em`, `bloqueado_motivo`, `onboarding_status`, `convite_token`, `sif` | Todas as 7 NÃO existem |
| `oportunidades` | 26 | `modo_distribuicao`, `status_cliente`, `prometida_em`, `expira_em` | Todas as 4 NÃO existem |
| `propostas_v3` | **0** | `tipo`, `hit` + RENAME `score` → `score_total` | Todas NÃO existem; `score` existe |
| `deals` | 2 | `etapa_atual` (smallint CHECK 1..11), `etapa_iniciada_em`, `concluido_em` | Todas as 3 NÃO existem |

**Total: 16 ADD COLUMN + 1 RENAME COLUMN.**

### 2.2 Tabelas-alvo sem ALTER

| Tabela | Linhas | Razão |
|---|---|---|
| `deal_produtos` | **0** | Decisão #7: COMMENT 'DEPRECATED' em `comissao_pct/valor` na S2; DROP só em S5 |
| `nf_uploads` | **0** | Decisão #6: `dados_extraidos` e `lida_ia` dormentes (já existem da 007) |
| `comissoes` | **0** | Decisão #4: dormente na V1; schema agregado deal-level já completo (mesa/seller/originador pct/valor) |

### 2.3 Achado: 4 tabelas-alvo zeradas reduzem risco da S2

- `propostas_v3` **0 linhas**: RENAME `score` → `score_total` é zero-risco do lado de dados. Risco fica só no front-end (D5 abaixo).
- `deal_produtos` **0 linhas**: backfill em `deal_produtos_comissao` é NO-OP. Bloco 7 do §10 da arquitetura vira instrução nula.
- `nf_uploads` **0 linhas**: nada a migrar.
- `comissoes` **0 linhas**: nada a migrar.

### 2.4 `deals` (2 linhas, dados de teste)

Default `etapa_atual=1` aceito (D8). Sem UPDATE manual em S2.

---

## 3. Tabelas legado mapeadas — não tocar na V1

### 3.1 Pares versionados (BLOCO B)

| Par | v1 (linhas, último) | v2 (linhas, último) | Oficial | Uso na V1 |
|---|---|---|---|---|
| aprovacoes / aprovacoes_v2 | 26 (18/abr) | 26 (19/abr) | **v2** | Aprovações de proposta — viva (investigar S3) |
| demandas / demandas_v2 | 18 (13/abr) | 25 (18/abr) | v2 | Substituída por `oportunidades` |
| mensagens / mensagens_v2 | 48 (13/abr) | 0 | v1 (com dados) | Substituída por `comunicacoes` (NEW V1) |
| negociacoes / negociacoes_v2 | 22 (13/abr) | 1 (18/abr) | v2 (parcial) | Sem equivalente em V1 (fluxo direto demanda→proposta→deal) |

### 3.2 `members` (BLOCO C)

- 46 linhas, 21 colunas (`razao_social`, `cnpj`, `cpf`, `originador_id`, `seller_id`, `aprovado_por`, `contrato_assinado`, …).
- **Confirmado tabela de aplicação**, NÃO Supabase Auth (Supabase Auth fica em `auth.users`, não exposto via PostgREST).
- Predecessor de `players` (43 linhas, 10 colunas — subset enxuto).
- Não tocada na S2. Cruzamento `members` → `players` pode ficar pra Fase 2 ou nem ocorrer.

### 3.3 Outras tabelas legado/órfãs (do BLOCO A inicial)

Tabelas com 0 linhas em `public` que aparecem como herança ou estub: `acordos_comerciais`, `avaliacoes`, `chat_deal`, `compradores`, `contra_propostas`, `contratos`, `documentos`, `financials_v2`, `fornecedor_produtos`, `fornecedores`, `fornecedores_v2`, `ia_logs`, `nf_documentos`, `notificacoes`, `notificacoes_v2`, `originadores`, `pedido_conformidade`, `pedidos`, `pedidos_v2`, `produtos`, `produtos_v2`, `propostas_v2`, `propostas_v3` (zerada mas alvo S2), `recompras`, `sellers`, `tabloide_itens`, `tabloides`, `tags`, `tracking`, `tracking_v2`, `user_kyc`, `whatsapp_pushes`. **Não tocar na S2.**

### 3.4 Decisão consolidada

- **Nenhum DROP** em qualquer tabela legado (D1).
- `COMMENT ON TABLE … IS 'LEGADO V0 — não usar em V1'` é **opcional na S2**, fica pra S5 se apertado (D2).
- **Não endurecer RLS de legado agora** — risco alto de quebrar HTMLs antigos. Smoke test S5 com grep do front decide (D3).

---

## 4. RLS atual

### 4.1 O que sabemos (análise estática das migrations)

**RLS HABILITADA via `ALTER TABLE … ENABLE ROW LEVEL SECURITY`** em 12 tabelas:

| Migration | Tabelas |
|---|---|
| 004 (linhas 147-156) | `players`, `vinculos`, `produtos_v2`, `oportunidades`, `propostas_v3`, `deals`, `comissoes`, `chat_deal`, `documentos`, `aprovacoes_v2` |
| 006 (linha 16) | `deal_produtos` |
| 007 (linha 23) | `nf_uploads` |

✅ Todas as 7 tabelas-alvo da S2 têm RLS habilitada.

### 4.2 Achado crítico

**Zero `CREATE POLICY` em todas as migrations 001-007.**

Hipótese forte: **policies foram criadas via Dashboard manualmente** e nunca commitadas. Sem isso, RLS habilitada bloquearia toda leitura via ANON_KEY — e o front-end V0 funciona, então policies devem existir.

### 4.3 Limitação técnica desta sessão

RPC `exec_sql` **não existe** no projeto Supabase (`PGRST202`). PostgREST/OpenAPI não expõe `pg_policies`/`relrowsecurity`. Não há `DATABASE_URL` em `.env.local` nem PAT pra Management API. **Listagem real só pelo Dashboard SQL Editor.**

### 4.4 Queries pra rodar no Dashboard (anexo a colar pelo CEO)

```sql
-- Q1. RLS habilitada por tabela em public
SELECT c.relname AS tabela,
       c.relrowsecurity AS rls_enabled,
       c.relforcerowsecurity AS rls_forced,
       (SELECT count(*) FROM pg_policies p
        WHERE p.schemaname='public' AND p.tablename=c.relname) AS n_policies
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname='public' AND c.relkind='r'
ORDER BY c.relname;

-- Q2. Policies de public (USING / WITH CHECK)
SELECT tablename, policyname, cmd, permissive, roles::text, qual, with_check
FROM pg_policies
WHERE schemaname='public'
ORDER BY tablename, policyname;

-- Q3. Helpers planejados pra V1 — já existem?
SELECT n.nspname AS schema, p.proname AS funcao,
       pg_get_function_arguments(p.oid) AS args,
       pg_get_function_result(p.oid) AS retorno
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname='public'
  AND p.proname IN ('auth_player_id','is_mesa','is_stakeholder_deal','carteira_seller','carteira_originador')
ORDER BY p.proname;
```

> **Anexo:** colar resultado das 3 queries no fim deste doc após a S5 ou logo após a S2.

### 4.5 Decisão (atualizada após Q1/Q2/Q3 — 26/04/2026)

**Confirmado pelo Dashboard em 26/04/2026.**

A migration 009 **CRIA RLS do zero** nas 7 tabelas-alvo (que estão GREENFIELD — `0 policies` hoje, conforme Q1) + 5 novas, seguindo a matriz §6 do doc de arquitetura V1. **Risco de quebra ZERO no front V0** — ele não usa essas tabelas (Q2 confirma: policies V0 são primitivas baseadas em `auth.uid() = user_id`, em outras tabelas: `demandas`, `mensagens`, `propostas`, `negociacoes`, `fornecedores`, `ofertas`, `pedidos`, `profiles`). **Smoke test na S5** valida que arquitetura multi-papel V1 funciona pela primeira vez.

---

## 5. Edge Functions

### 5.1 Existentes (7)

| Function | Propósito | V1 |
|---|---|---|
| `dealer-agent` | WhatsApp AI → cria demandas em `mensagens_v2` | ❌ Legado V0 (WhatsApp inativo) |
| `email-agent` | Resend transacional | ✅ **Base pra refator em S4** |
| `financial-agent` | Cálculo de comissões/splits | ❌ Legado (Fase 3) |
| `onboarding-agent` | WhatsApp register em `members` + roles | ❌ Legado (V1 onboarda via web) |
| `ops-agent` | SLA/follow-up automáticos | ❌ Legado (§4.3 V1 sem SLA auto) |
| `produto-agent` | Classificação Claude + `categorias_referencia` | ⚠️ Reuso possível em V1 |
| `tracking-agent` | 8 fases sequenciais de tracking | ❌ Legado — conflita com 11 etapas em `deals.etapa_atual` |

### 5.2 Decisão: NÃO desabilitar functions legado agora (D11)

WhatsApp não está divulgado → sem gatilho externo → risco zero. Mas algum HTML legacy pode invocar internamente (`tracking-agent`, `financial-agent`, etc.). **Smoke test S5 valida**. Se aparecer chamada, tratar caso a caso.

### 5.3 A criar em S4 (3 functions)

| Function | Notas |
|---|---|
| `enviar-email` | **Refator do `email-agent` existente.** `RESEND_API_KEY` já em `.env.local`. Domínio `brazilfoodhub.com` verificado no Resend hoje (D14) |
| `clicksign-enviar` | Cria documento + signers no ClickSign (`CLICKSIGN_API_KEY` já em `.env.local`) |
| `clicksign-webhook` | Recebe assinaturas, valida HMAC (`CLICKSIGN_WEBHOOK_SECRET` já em `.env.local`), dispara avanço pra etapa 3 |

---

## 6. Storage Buckets

### 6.1 Estado atual: NENHUM bucket configurado

Mas o schema atual já tem campos URL apontando pra storage:
- `deal_produtos.nf_url`, `deal_produtos.nf_numero`
- `nf_uploads.nf_url`

### 6.2 Decisão: criar buckets MANUALMENTE no Dashboard durante a S4 (D12)

| Bucket | Privacidade | Conteúdo |
|---|---|---|
| `termos` | Privado | PDFs gerados de `termos_acordo` (input pro ClickSign) |
| `nfs` | Privado | Uploads de NF da etapa 6 (`nf_uploads.nf_url`) |

Não cria via migration. Configuração manual no Dashboard pelo CEO/Samanta antes/durante a S4.

---

## 7. Decisões da CEO consolidadas (sessão bônus 26/abr)

Numeradas D1-D17 pra facilitar referência futura.

| # | Decisão | Origem |
|---|---|---|
| **D1** | Nenhum DROP em qualquer tabela legado (BLOCO B + `members` + órfãs) | BLOCO B R1 |
| **D2** | `COMMENT ON TABLE … IS 'LEGADO …'` opcional na S2; fica pra S5 se apertado | BLOCO B R2 |
| **D3** | Não endurecer RLS de tabelas legado agora; smoke test S5 com grep front decide | BLOCO B R3 |
| **D4** | `aprovacoes_v2` intacta na S2; investigação na S3 quando aprovação de oportunidade for implementada | BLOCO B |
| **D5** | RENAME `propostas_v3.score` → `score_total` mantém-se (decisão #3 da S1); 0 linhas no banco mas grep front-end fica como tarefa explícita | BLOCO A |
| **D6** | Migration 008 (comissoes/nf tracking) **descartada** e movida pra `supabase/migrations/_abandoned/` (gitignored). Substituída pela arquitetura Mesa Concierge V1 | Alerta 2 |
| **D7** | JWT `service_role` hardcoded em `008_run.js` resolvido pelo movimento pra `_abandoned/` (fora do git) | Alerta 3 |
| **D8** | 2 deals existentes herdam `etapa_atual=1` por default — são dados de teste, sem UPDATE manual | Alerta 4 |
| **D9** | Migration 009 **cria** RLS pela primeira vez nas 7 tabelas-alvo (greenfield, confirmado por Q1) + 5 novas; risco de quebra ZERO no V0 (Q2); smoke test S5 valida arquitetura multi-papel V1 | BLOCO D + Q1/Q2 26/04 |
| **D10** | `members` é legado de aplicação; cruzamento/migração `members` → `players` pode ficar pra Fase 2 ou nem ocorrer | BLOCO C |
| **D11** | Não desabilitar Edge Functions legado agora (WhatsApp inativo = sem gatilho externo); smoke test S5 valida HTMLs | BLOCO E 1-3 |
| **D12** | Buckets `termos` e `nfs` (privados) criados **manualmente no Dashboard** durante a S4 | BLOCO E 5 |
| **D13** | `email-agent` reutilizado via refator em S4 → vira `enviar-email` (não criar do zero) | BLOCO E 4 |
| **D14** | Domínio `brazilfoodhub.com` verificado no Resend (DNS validado) | BLOCO E 6 |
| **D15** | Conflito `tracking-agent` (8 fases) vs `deals.etapa_atual` (11 etapas) registrado como TODO da S5 | BLOCO E 7 |
| **D16** | Sessão de domingo é READ-ONLY no banco; OK mover arquivos no file system | Premissa |
| **D17** | Não criar scripts auxiliares fora do plano combinado, especialmente que cruzem PII | Memória `feedback_no_aux_scripts_pii.md` |

---

## 8. Recomendações para S2 — plano atualizado

### 8.1 Plano de execução (mantém §10 do doc de arquitetura, com ajustes)

| Bloco | Ação | Estado real | Tempo estimado |
|---|---|---|---|
| 1 | ALTER `players` (+7 colunas) | Cru — todas a criar | 30 min |
| 2 | ALTER `oportunidades` (+4 colunas) | Cru — todas a criar | 20 min |
| 3 | ALTER `propostas_v3` (+2 colunas + RENAME `score`→`score_total`) | 0 linhas — zero risco de dados | 20 min |
| 4 | ALTER `deals` (+3 colunas com CHECK 1..11) | 2 linhas (teste) — default OK | 20 min |
| 5 | CREATE `oportunidade_convites` | Nova | 15 min |
| 6 | CREATE `deal_produtos_comissao` | Nova | 15 min |
| 7 | Backfill `deal_produtos.comissao_*` → `deal_produtos_comissao` | **NO-OP** (0 linhas em deal_produtos) | 5 min |
| 7.1 | `COMMENT ON COLUMN deal_produtos.comissao_pct/valor IS 'DEPRECATED…'` | Decisão #7 da S1 | 5 min |
| 8 | CREATE `deal_eventos` + trigger imutabilidade | Nova | 30 min |
| 9 | CREATE `termos_acordo` + trigger AFTER UPDATE de avanço pra etapa 3 | Nova | 30 min |
| 10 | CREATE `comunicacoes` | Nova | 20 min |
| 11 | Funções helper (`auth_player_id`, `is_mesa`, `is_stakeholder_deal`, `carteira_seller`, `carteira_originador`) | Confirmar via Q3 (provável: NÃO existem) | 45 min |
| 12 | Trigger piso 0,5% em `deal_produtos_comissao` (CHECK + EXCEPTION) | Novo | 15 min |
| **13** | **RLS CREATE puro** das 12 tabelas (7 alvo greenfield + 5 novas) | **CONFIRMADO Q1**: 7 alvo têm `0 policies` hoje. Não há reescrita — só CREATE seguindo matriz §6 | **45 min** |
| 14 | Bloco F — testes RLS embutidos (queries que devem retornar 0 linhas para personas erradas) | Novo | 30 min |

### 8.2 Estimativa atualizada (pós-Q1/Q2/Q3)

- **Original (S1):** 6 h
- **Revisado (pós-diagnóstico A-E):** ~7 h (estimativa intermediária)
- **Revisado (pós-Q1/Q2/Q3 — 26/04/2026):** **6 h** ← volta pro original
  - Q1 confirmou: 7 tabelas-alvo são GREENFIELD (`0 policies`). Bloco 13 vira CREATE puro, não reescrita. Volta pra ~45 min.
  - Reduções: backfill NO-OP (-25 min), 4 tabelas-alvo zeradas, bloco 13 GREENFIELD
  - Aumentos: nenhum significativo

### 8.3 Pendências externas pré-S2

| # | Item | Quem |
|---|---|---|
| 1 | Rodar Q1/Q2/Q3 no Dashboard SQL Editor e colar resultado no anexo §11 | CEO (pós-BLOCO F) |
| 2 | Confirmar que nenhum HTML legacy chama tabelas v1 (`mensagens`, `demandas`, `negociacoes`) — se chamar, antecipar pra S2 | (S5 smoke test) |

---

## 9. Riscos e mitigações

| # | Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|---|
| R1 | Front-end usa `propostas_v3.score` em algum HTML | Média | Médio (componente quebra) | S2: grep do front antes do RENAME; ajustar usos no mesmo commit. S5 valida |
| R2 | Front-end V0 lê `deal_produtos.comissao_pct/valor` | Média | Baixo (COMMENT não quebra) | DROP só em S5 após grep. S2 mantém colunas vivas |
| R3 | RLS criada na 009 corta acesso de algum HTML legacy | **Baixa** (Q2 26/04 confirma front V0 não usa tabelas-alvo da S2) | Médio (página fica vazia) | Smoke test S5 com cada persona; ajuste cirúrgico se quebrar |
| R4 | HTML legacy chama Edge Function legado (`tracking-agent`, etc.) | Baixa | Baixo (function continua existindo) | Smoke test S5; se aparecer, refator ou desabilitação |
| R5 | Domínio Resend não validado a tempo da S4 | Baixa (já validado D14) | Alto (e-mails não saem) | Re-checar antes da S4 |
| R6 | Buckets de Storage não criados antes do primeiro `clicksign-enviar` | Média | Médio (upload falha) | D12: criar buckets na primeira ação da S4, antes de testar function |
| R7 | Helpers `auth_player_id` etc. já existem com assinatura diferente | Baixa | Baixo (CREATE OR REPLACE resolve) | Q3 confirma; usar `CREATE OR REPLACE FUNCTION` |
| R8 | `aprovacoes_v2` tem RLS própria que conflita com fluxo V1 | Média | Médio (aprovação mesa quebra) | S3 investigação dedicada, antes de tocar em fluxo de aprovação |

---

## 10. TODO list pra S5 (smoke test)

- [ ] **Grep front-end:** `propostas_v3.score` (qualquer HTML/JS) — atualizar pra `score_total`
- [ ] **Grep front-end:** `deal_produtos.comissao_pct`, `deal_produtos.comissao_valor` — se zero ocorrências, **OK pra DROP COLUMN em S5**
- [ ] **Grep front-end:** `from('mensagens')`, `from('demandas')`, `from('negociacoes')`, `from('members')` — se zero, OK endurecer RLS dessas legado (D3 reverso)
- [ ] **Grep front-end:** chamadas a Edge Functions `tracking-agent`, `financial-agent`, `ops-agent`, `dealer-agent`, `onboarding-agent` — se zero, mover pra `_abandoned_functions/`
- [ ] **Smoke test RLS** com cada persona (mesa, indústria, cliente, seller, originador) usando ANON_KEY → confirmar que matriz §6 é cumprida
- [ ] **Validar primeiro funcionamento da arquitetura RLS multi-papel V1** (esta migration foi a primeira tentativa real — Q1/Q2 confirmaram que as 7 tabelas-alvo eram greenfield)
- [ ] **Validar conflito** `tracking-agent` vs `deals.etapa_atual` (D15)
- [ ] **Avaliar** `COMMENT ON TABLE … IS 'LEGADO V0 — não usar em V1'` nas 7 tabelas legado (D2 — opcional)
- [ ] **Avaliar** `aprovacoes_v2` em uso real (D4)

---

## 11. Anexo — output das queries Q1/Q2/Q3

**Confirmado pelo CEO via Dashboard SQL Editor em 26/04/2026.**

### Q1 — RLS por tabela (resumo executivo)

- **54 tabelas analisadas**, todas com `rls_enabled=true`
- **7 tabelas-alvo da S2: ZERO policies** (greenfield)
  - `players`, `oportunidades`, `propostas_v3`, `deals`, `deal_produtos`, `nf_uploads`, `comissoes` → `n_policies = 0`
- **12 tabelas legado COM policies** (em uso pelo front V0):
  - `demandas` (8), `mensagens` (6), `propostas` (6), `negociacoes` (7), `fornecedores` (4), `ofertas` (4), `pedidos` (4), `profiles` (4)
  - + `avaliacoes`, `contra_propostas`, `notificacoes`, `recompras`, `user_kyc`, `user_preferences` (policies básicas)

### Q2 — Policies em public (resumo executivo)

- Policies existentes seguem padrão **SIMPLES** baseado em `auth.uid() = user_id` ou `auth.role() = 'authenticated'`
- **Nenhuma policy menciona `players`, `is_mesa`, `is_stakeholder_deal`** ou qualquer função da arquitetura V1
- **Confirma**: V3 schema (`oportunidades`, `propostas_v3`, `deals`, `players`) **nunca rodou em produção** — front V0 só toca tabelas legado
- Implicação: arquitetura multi-papel V1 estreia na S2 sem conflito com policies pré-existentes nas 7 alvo

### Q3 — Helpers planejados pra V1

```
Success. No rows returned.
```

- **0 funções helper existem**
- Os 5 (`auth_player_id`, `is_mesa`, `is_stakeholder_deal`, `carteira_seller`, `carteira_originador`) serão **criados do zero na S2** (bloco 11 do §10 da arquitetura)
- Sem risco de colisão com assinaturas pré-existentes

---

## 12. Aplicação da S2 em 27/04/2026 ✅

### 12.1 Resumo executivo

S2 aplicada com sucesso no Dashboard Supabase em 27/abr/2026. Migration `supabase/migrations/009_mesa_concierge_v1.sql` (1.717 linhas, 74 KB) materializa o schema mínimo da Mesa Concierge V1 em 20 blocos com transação por bloco (`BEGIN/COMMIT`) e idempotência total.

A migration foi escrita incrementalmente em conjunto Claude Code (file approval) + Mesa Estratégica (decisões de produto), aplicada bloco a bloco no Dashboard SQL Editor pelo CEO. O B01 foi escrito originalmente no arquivo via Claude Code; B02-B20 foram escritos diretamente no Dashboard durante a execução, com sincronização final do arquivo após o B20 validar.

### 12.2 Decisões CEO adicionais durante S2 — D21..D31

| # | Decisão | Origem |
|---|---|---|
| **D21** | Seller e originador, por terem carteira fechada vitalícia (Pilar 4), enxergam **todo o ciclo de vida** dos deals deles: status, etapas, datas, volumes, preços, NF, eventos, deal_produtos. Não veem comissão de outros papéis. RLS por linha em `comissoes` (não COLUMN-LEVEL) | RN4 — atualização de visibilidade |
| **D22** | Carteira herdada **automaticamente** do cadastro do player. `players.seller_id` / `originador_id` (NULL = mesa solo). Self-reference proibido por CHECK. Trigger B18 protege a vitalicidade | RN7 |
| **D23** | Comissão por **SKU/produto**, não por deal nem por papel. Cada linha em `deal_produtos_comissao` tem seu próprio `comissao_pct` com piso 0,5% por SKU. Diferentes produtos podem ter comissões diferentes (ex: SKU A 1,5%, SKU B 0,8%, SKU C 2,0%). O `pct_total` do deal é **calculado** por média ponderada pelo valor do SKU (D31) — NÃO é informado direto pela mesa | RN1 / B06 / B15 |
| **D24** | Divisão automática igualitária da comissão global do deal entre papéis presentes: 100% (1 papel) / 50–50 (2) / 33,34–33,33–33,33 (3). Operador não informa split — calculado por `calcular_split_comissao()` (B15) chamada em trigger AFTER UPDATE de `termos_acordo` | RN8 |
| **D25** | UX e fluxo financeiro: indicador permanente no deal (% + R$), pop-up sob demanda com composição tributária, consolidação mensal em `comissoes_periodo`. Status evolui: `pendente → estruturada → fechada_periodo → paga` | RN9 |
| **D26** | V1 com **3 papéis ativos**: `mesa` / `seller` / `originador`. Schema extensível para futuros papéis (4º = parceiro logístico, agente regional, etc.). CHECK atual: `papel IN ('mesa','seller','originador')` — trocar a constraint quando precisar | Mesa Estratégica |
| **D27** | Mesa pode reatribuir `seller_id`/`originador_id` em players, mas **com auditoria imutável** em tabela própria `auditoria_carteira` (8 colunas, UPDATE/DELETE bloqueados por trigger). Mudança valor→NULL é proibida | RN7 + Pilar 4 |
| **D28** | Trigger de piso agregado por deal (B18 original) **descartado**. CHECK individual ≥ 0.005 por SKU em `deal_produtos_comissao` (B06) já garante matematicamente SUM ≥ 0.005 por deal. B18 vira "trigger carteira vitalícia + auditoria" e plano vira 20 stops (era 21) | RN1 |
| **D29** | Snapshot de carteira em deals: novas colunas `deals.seller_id_snapshot` / `originador_id_snapshot` capturam o vínculo no momento de criação do deal. Imutáveis após criação. Helpers `carteira_seller(deal_id)` / `carteira_originador(deal_id)` retornam **uuid** (não boolean) lendo desses snapshots | RN7 + Pilar 4 |
| **D30** | SLAs etapas 9-11 fixados em 24h/48h/72h respectivamente. Etapas 1-4 conforme RN3 (instantâneo / 48 / 72 / 24); etapas 5-8 = 168h (7 dias). Tabela `etapa_sla_padrao` configurável via UPDATE conforme operação real | RN3 |
| **D31** | `pct_total_deal` calculado por **média ponderada** pelo valor do SKU: `SUM(pct × valor_total) / SUM(valor_total)`. Soma simples descartada (gera valores irreais quando SKUs têm pesos diferentes — justificativa CFO) | RN8 / B15 |

### 12.3 Regras de negócio implementadas — RN1..RN9

| # | Regra | Onde está implementada |
|---|---|---|
| **RN1** | Comissão é variável caso a caso. Piso 0,5% por SKU, não por deal | CHECK em B06 + trigger B16 (mensagem amigável) |
| **RN2** | Score de proposta = 60% preço + 15% prazo + 10% frete + 15% supplier_score. V1: supplier_score parte de 50 (neutro). Score salvo no momento da criação (não recalcula) | Estrutura em B03 (`score_total`). Cálculo via RPC fica para S3 |
| **RN3** | SLA por etapa (24h–168h). V1 implementa **struct**; detecção automática (yellow/red flag) fica para V1.5 | Tabela `etapa_sla_padrao` em B13 (seed 11 etapas) |
| **RN4** | Seller/originador enxergam todo ciclo do deal (D21). Comissão por linha em `comissoes` — cada papel vê SUA linha, mesa vê tudo, cliente bloqueado | Helpers B14 + RLS B19a-e (52 policies) |
| **RN5** | Notificações com matriz por evento + yellow/red flag. V1 implementa **struct** em `comunicacoes`; Edge Function dispara emails Resend; detecção automática fica para V1.5 | Tabela `comunicacoes` em B10 |
| **RN6** | Migração de deals reais: 1/mai smoke test com deal sintético (CEO + Samanta como atores). Após sucesso fim a fim, primeiro deal real (#15 Ataca Tudo). 3 deals quentes operam em paralelo manualmente até validação | Operacional — não é schema |
| **RN7** | Carteira herdada do cadastro do player. NULL = mesa solo. Trigger B18 protege a vitalicidade. Snapshots em deals (D29) | B01 (colunas em players) + B04 (snapshots) + B14 (helpers) + B18 (trigger + auditoria) |
| **RN8** | Divisão automática igualitária entre papéis presentes (100/50/33,33). Operador não informa split | Função `calcular_split_comissao()` em B15, chamada por trigger AFTER UPDATE de `termos_acordo` em B17 |
| **RN9** | UX e fluxo financeiro mensal. Status evolui pendente→estruturada→fechada_periodo→paga | Tabelas `comissoes` (refator B11) + `comissoes_periodo` (B12) |

### 12.4 Lista de blocos aplicados — B01..B20

| # | Bloco | Resultado |
|---|---|---|
| B01 | ALTER players (+9 colunas) | ✅ 43 linhas vivas; defaults aplicados |
| B02 | ALTER oportunidades (+4 colunas) | ✅ 26 linhas vivas; `modo_distribuicao='broadcast'`, `status_cliente='pendente'` |
| B03 | ALTER propostas_v3 (+2 + RENAME `score`→`score_total`) | ✅ 0 linhas; RENAME idempotente via `DO $$` |
| B04 | ALTER deals (+5 colunas: 3 etapa + 2 snapshot D29) | ✅ 2 linhas (teste); defaults aplicados |
| B05 | CREATE oportunidade_convites | ✅ + RLS habilitada |
| B06 | CREATE deal_produtos_comissao (CHECK piso 0,5% por SKU) | ✅ + RLS habilitada |
| B07 | Backfill NO-OP + `COMMENT DEPRECATED` em deal_produtos | ✅ 0 linhas migradas (NO-OP); colunas marcadas |
| B08 | CREATE deal_eventos + trigger imutabilidade | ✅ UPDATE/DELETE bloqueados |
| B09 | CREATE termos_acordo | ✅ + RLS habilitada |
| B10 | CREATE comunicacoes | ✅ + RLS habilitada |
| B11 | REFATORAR comissoes (DROP CASCADE + CREATE linha-por-papel) | ✅ schema novo (UNIQUE deal_id+papel) |
| B12 | CREATE comissoes_periodo + FK em comissoes | ✅ consolidação mensal |
| B13 | CREATE etapa_sla_padrao + seed 11 etapas | ✅ valores D30 (24/48/72/24/168×4/24/48/72) |
| B14 | Helpers SQL — 5 funções (carteira_* retornam **uuid**) | ✅ `auth_player_id`, `is_mesa`, `is_stakeholder_deal`, `carteira_seller`, `carteira_originador` |
| B15 | Função calcular_split_comissao(deal_id) [versão corrigida] | ✅ média ponderada (D31); mensagens RAISE com "por cento" em vez de `%%%` |
| B16 | Trigger piso 0,5% individual em deal_produtos_comissao | ✅ mensagem amigável |
| B17 | Trigger termos_acordo (auto-avanço etapa + chama calcular_split) | ✅ AFTER UPDATE quando 3 assinaturas presentes |
| B18 | Trigger carteira vitalícia + tabela auditoria_carteira (D27) | ✅ 8 colunas; 2 triggers de imutabilidade na auditoria |
| B19a-e | RLS em 15 tabelas — **52 policies** distribuídas em 5 sub-blocos | ✅ matriz §6 da arquitetura aplicada |
| B20 | Smoke test (Bloco F — validação) | ✅ rodado direto no Dashboard, não escreve schema |

### 12.5 Validações finais (Dashboard SQL Editor, 27/abr)

- **15 tabelas com RLS ativo:** players, oportunidades, propostas_v3, deals, deal_produtos, deal_produtos_comissao, comissoes, comissoes_periodo, deal_eventos, termos_acordo, oportunidade_convites, comunicacoes, nf_uploads, etapa_sla_padrao, auditoria_carteira
- **6 funções SQL:** 5 helpers + `calcular_split_comissao`
- **8 triggers críticos ativos:** imutabilidade deal_eventos (×2), imutabilidade auditoria_carteira (×2), piso 0,5% individual, termos_acordo auto-avanço, carteira vitalícia, atualizado_em
- **11 etapas SLA seedadas** em `etapa_sla_padrao`
- **52 policies RLS** distribuídas
- **2 CHECK constraints contra self-reference** (`players_seller_no_self`, `players_originador_no_self`)

### 12.6 Próximas sessões

- **S3 — terça 28/abr (6h):** Onboarding + cliente cria demanda + indústria responde proposta + RPC de score (RN2: 60/15/10/15) + cliente vê propostas ranqueadas. Plano-v3 §9.
- **S4 — quarta 29/abr (6h):** Termo + ClickSign + Resend + dashboard mesa.html. Pré-requisito: 7 docs jurídicos (advogada 29/abr) + buckets `termos`/`nfs` criados manualmente no Dashboard.
- **S5 — quinta 30/abr (4h):** Smoke test + ajustes + republish brazilfoodhub.com.
- **Sex 1/mai:** entrega Mesa Concierge V1 no ar.

---

*Documento vivo. Atualizar em S5 com resultado real do smoke test e eventual DROP de colunas DEPRECATED em deal_produtos.*
