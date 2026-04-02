# FoodHub — Contexto do Projeto

## Produto
Plataforma B2B de intermediação de compras de alimentos. Mesa Nacional de Oportunidades — conecta compradores (food service, varejo, atacado) a fornecedores homologados.

## Stack
- Single page app: HTML/CSS/JS puro (sem framework)
- Banco: Supabase (PostgreSQL) — variável _sb já configurada no index.html
- Auth: Supabase Auth — usuário logado disponível em _currentUser
- Hospedagem: GitHub Pages (repositório MyFoodHub/Food-Hub)

## Supabase
- URL: https://jqbuckofiaopxwllghac.supabase.co
- Chave pública: sb_publishable_LFZQkiPcCv1NbBLu6jUPXg_N5qY8zmi

## Tabelas principais
- profiles, fornecedores, produtos, demandas, propostas, negociacoes, mensagens, contra_propostas, pedidos, tracking, avaliacoes, notificacoes, ofertas

## Padrões do código
- Usar var (não let/const) para compatibilidade
- Funções async/await para Supabase
- Visual: manter exatamente o mesmo estilo do app (dark theme, CSS variables)
- Sempre mostrar loading enquanto busca dados
- Sempre tratar erro do Supabase com mensagem na tela
- Após qualquer mudança: git add index.html && git commit && git push origin main

## Módulos a conectar (em ordem de prioridade)
1. ✅ Demandas — criar e listar do banco (FEITO)
2. ✅ Fornecedores — listar do banco + tela de cadastro (FEITO)
3. ⏳ Propostas — fornecedores enviando propostas reais
4. ⏳ Negociação — chat em tempo real com Supabase Realtime
5. ⏳ Notificações — badge ao vivo sem refresh
6. ⏳ Relatórios — métricas reais do banco
7. ⏳ Rastreamento — timeline de entrega do banco
8. ⏳ Recompra — sugestões baseadas em histórico

## Como trabalhar
- Sempre ler este arquivo antes de começar
- Nunca usar dados fictícios (arrays JS estáticos) — sempre buscar do Supabase
- Manter o visual idêntico ao existente
- Testar no app após cada mudança: https://myfoodhub.github.io/Food-Hub/
