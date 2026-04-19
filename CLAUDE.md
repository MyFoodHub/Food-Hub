# FoodHub V3 — Contexto Completo

## Visao do Produto
Plataforma B2B de intermediacao de compras de alimentos. A maior mesa de oportunidades do Brasil.
Conecta industrias (fornecedores) a clientes (compradores) atraves de intermediarios (sellers e originadores).
Identidade: clube privado, exclusivo, apenas convidados. Tom profissional, direto, confiante.

## Stack
- Frontend: HTML/CSS/JS puro (sem framework) — cada perfil tem seu app
- Banco: Supabase (PostgreSQL) com RLS
- Auth: Supabase Auth (email + senha)
- Hospedagem: GitHub Pages
- Dominio: brazilfoodhub.com
- Repositorio: github.com/MyFoodHub/Food-Hub
- AI Agents: Supabase Edge Functions (Deno/TypeScript) — nao deployados ainda
- Emails: Resend (nao configurado ainda)

## Supabase
- URL: https://jqbuckofiaopxwllghac.supabase.co
- Projeto: jqbuckofiaopxwllghac

## Apps (URLs)
| App | URL | Perfil |
|---|---|---|
| entrar.html | /entrar.html | Login universal — detecta tipo e redireciona |
| vitrine.html | /vitrine.html | Industria (fornecedor) |
| demandas.html | /demandas.html | Cliente (comprador) |
| carteira.html | /carteira.html | Intermediario (seller + originador) |
| mercado.html | /mercado.html | Marketplace — oportunidades rankeadas |
| mesa.html | /mesa.html | Mesa FoodHub (torre de controle) — senha: FOODHUB_MESA_2026 |
| index.html | /index.html | App V1 comprador (legado, ainda funciona com tabelas V1) |
| industria.html | /industria.html | App V1 fornecedor (legado) |

## Tabelas V3 (atuais — usar estas)
```
players          — cadastro unico, tipo text[] (industria/cliente/seller/originador/mesa)
vinculos         — quem trouxe quem (intermediario_id → player_id, papel: originador/seller)
oportunidades    — demandas dos clientes (codigo, produto_descricao, tags, volume, preco_alvo, status)
propostas_v3     — propostas das industrias para oportunidades
deals            — negocios em andamento ou fechados (links oportunidade + proposta + stakeholders)
deal_produtos    — produtos de cada deal (volume, preco_unitario, valor_total, comissao)
comissoes        — comissao por deal (mesa_pct, seller_pct, originador_pct, valores)
chat_deal        — mensagens do deal
documentos       — NFs, contratos, acordos
aprovacoes_v2    — log central de aprovacoes (tipo, entidade_id, status)
produtos_v2      — catalogo livre (descricao_livre, tags, canais, regioes — IA organiza)
categorias_referencia — categorias macro para orientar IA
```

## Tabelas V1 (legadas — usadas por index.html e industria.html)
```
profiles, demandas, propostas, negociacoes, mensagens, pedidos,
fornecedores, ofertas, categorias, tracking, avaliacoes, notificacoes
```

## Tabelas V2 (intermediarias — criadas na migracao, podem ser ignoradas)
```
members, demandas_v2, propostas_v2, negociacoes_v2, mensagens_v2,
pedidos_v2, tracking_v2, financials_v2, fornecedores_v2, sellers,
originadores, compradores, acordos_comerciais, contratos, nf_documentos,
ia_logs, tags, notificacoes_v2
```

## Regras de Negocio
1. **Papeis multiplos**: um player pode ter varios tipos simultaneamente (ex: originador + seller)
2. **Vinculos**: quem trouxe quem. Originador traz industria, seller traz cliente
3. **Comissao caso a caso**: mesa define % por deal, nao regra fixa
4. **Comissao invisivel**: comprador NUNCA ve comissao. Fornecedor so ve no contexto do acordo
5. **Aprovacao da mesa**: tudo passa pela mesa antes de ativar (players, produtos, oportunidades, deals)
6. **Produtos livres**: cadastro em texto livre, IA classifica com tags. Nunca engessar com campos fixos
7. **Matching por tags**: sobreposicao de tags entre produto e oportunidade = score de match
8. **Score do cliente**: cliente define pesos (preco/prazo/pagamento) para rankear propostas
9. **Status de negocio**: rascunho→Prospeccao, ativa→Em negociacao, fechado→Venda Realizada, faturado→Faturado

## Padroes do Codigo
- Usar `var` (nao let/const) para compatibilidade
- Funcoes async/await para Supabase
- Visual: dark theme (#050810 bg, #080D18 cards, #00C8FF accent)
- Font: DM Sans
- Mobile-first com bottom nav (5 tabs)
- Desktop: sidebar lateral
- Sempre mostrar loading enquanto busca dados
- Sempre tratar erro do Supabase com mensagem na tela
- Frases de loading: "Sua mesa esta sendo preparada...", "Buscando os melhores negocios..."

## AI Agents (Supabase Edge Functions — codigo pronto, nao deployados)
```
supabase/functions/
  _shared/config.ts    — Supabase client, Claude API, helpers
  dealer-agent/        — WhatsApp conversacional (1711 linhas)
  onboarding-agent/    — Cadastro de novos membros
  financial-agent/     — Ciclo de comissoes
  tracking-agent/      — Rastreamento de pedidos
  ops-agent/           — SLA e automacoes
  produto-agent/       — Classificacao de produtos via IA
  email-agent/         — Emails transacionais via Resend
```

## Credenciais Necessarias (nao expor nos arquivos)
- SUPABASE_SERVICE_ROLE_KEY — ja configurada nos apps
- SUPABASE_ANON_KEY — para auth no entrar.html
- ANTHROPIC_API_KEY — PENDENTE (necessaria para ativar agents de IA)
- RESEND_API_KEY — PENDENTE (necessaria para emails transacionais)
- TWILIO credentials — PENDENTE (para WhatsApp)

## Pipeline Real
- 43 players cadastrados (16 industrias, 20 clientes, 3 sellers, 3 originadores, 1 mesa)
- 26 oportunidades migradas do Excel (R$ 53.3M/mes total)
- 2 deals ativos (Venezuela bovinos R$7.7M + Zamp Pepsi R$1.8M)
- 27 vinculos (originador→industria, seller→cliente)

## O que esta funcionando
- Login universal com deteccao de perfil (3 tiers: players → members → profiles)
- Mesa CRM split view com pipeline, filtros, edicao inline, timeline
- Aprovacoes com cards ricos e contexto
- Vitrine, demandas, carteira, mercado — todos conectados ao Supabase
- Score personalizado por cliente (pesos preco/prazo/pagamento)
- Cadastro hibrido de produtos (mesa cadastra em nome de industria)

## O que falta
- Deploy dos AI agents no Supabase
- ANTHROPIC_API_KEY para ativar IA
- RESEND_API_KEY para emails
- Twilio para WhatsApp
- DNS do dominio brazilfoodhub.com
- Tabela deal_produtos (SQL pronto em migrations/006)
- Coluna observacoes em oportunidades (SQL pronto em migrations/006)
