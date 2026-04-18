/**
 * FoodHub V3 — Produto Agent
 * Classificação inteligente de produtos alimentares B2B via Claude AI.
 *
 * Ações: classificar | buscar_match | aprovar | rejeitar | reclassificar
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  supabase,
  chamarClaude,
  criarAprovacao,
  logIA,
  jsonResponse,
  corsResponse,
  CORS_HEADERS,
  gerarCodigo,
} from "../_shared/config.ts";

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

interface ProdutoRequest {
  acao: string;
  descricao?: string;
  produto_id?: string;
  membro_id?: string;
  especificacao?: Record<string, unknown>;
  motivo?: string;
}

interface ClassificacaoClaude {
  categoria: string;
  subcategoria: string;
  nome_normalizado: string;
  tags: string[];
  variacoes: Record<string, string>;
  campos_relevantes: string[];
  confianca: number;
}

// ---------------------------------------------------------------------------
// Classificação via IA
// ---------------------------------------------------------------------------

async function classificarDescricao(descricao: string): Promise<ClassificacaoClaude> {
  // Buscar categorias de referência do banco
  const { data: categorias, error: catErr } = await supabase
    .from("categorias_referencia")
    .select("nome, subcategorias_comuns, tags_comuns");

  if (catErr) {
    throw new Error(`Erro ao buscar categorias: ${catErr.message}`);
  }

  const listaCategorias = (categorias || [])
    .map(
      (c: { nome: string; subcategorias_comuns: string[]; tags_comuns: string[] }) =>
        `- ${c.nome} (sub: ${(c.subcategorias_comuns || []).join(", ")}) [tags: ${(c.tags_comuns || []).join(", ")}]`
    )
    .join("\n");

  const systemPrompt = `Voce e especialista em classificacao de produtos alimentares B2B brasileiros.

Categorias disponiveis:
${listaCategorias}

Analise a descricao livre e retorne JSON:
{
  "categoria": "string",
  "subcategoria": "string",
  "nome_normalizado": "string (nome padronizado limpo)",
  "tags": ["tag1","tag2",...],
  "variacoes": {"campo": "valor", ...},
  "campos_relevantes": ["campo1","campo2",...],
  "confianca": 0.0-1.0
}

Seja generoso nas tags. Tags ajudam no match.
Inclua tags de: proteina, conservacao, embalagem, certificacao, corte, regiao se aplicavel.

Responda SOMENTE com o JSON, sem markdown, sem explicacoes.`;

  const resposta = await chamarClaude(descricao, systemPrompt);

  // Extrair JSON mesmo se vier envolto em markdown
  const jsonMatch = resposta.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("Claude nao retornou JSON valido na classificacao");
  }

  const parsed: ClassificacaoClaude = JSON.parse(jsonMatch[0]);

  // Validação básica
  if (!parsed.categoria || !parsed.nome_normalizado) {
    throw new Error("Classificacao incompleta: categoria ou nome ausente");
  }
  if (typeof parsed.confianca !== "number" || parsed.confianca < 0 || parsed.confianca > 1) {
    parsed.confianca = 0.5;
  }
  if (!Array.isArray(parsed.tags)) parsed.tags = [];
  if (!Array.isArray(parsed.campos_relevantes)) parsed.campos_relevantes = [];
  if (!parsed.variacoes || typeof parsed.variacoes !== "object") parsed.variacoes = {};

  return parsed;
}

// ---------------------------------------------------------------------------
// Ação: classificar
// ---------------------------------------------------------------------------

async function handleClassificar(descricao: string, membro_id: string) {
  const inicio = Date.now();

  const classificacao = await classificarDescricao(descricao);

  const codigo = await gerarCodigo("PRD", "produtos");

  const produto = {
    codigo,
    descricao_livre: descricao,
    categoria: classificacao.categoria,
    subcategoria: classificacao.subcategoria,
    nome_normalizado: classificacao.nome_normalizado,
    tags: classificacao.tags,
    variacoes: classificacao.variacoes,
    campos_relevantes: classificacao.campos_relevantes,
    confianca: classificacao.confianca,
    status: "revisado_ia",
    revisado_por_ia: true,
    criado_por: membro_id,
    criado_em: new Date().toISOString(),
  };

  const { data: produtoSalvo, error: insertErr } = await supabase
    .from("produtos")
    .insert(produto)
    .select()
    .single();

  if (insertErr) {
    throw new Error(`Erro ao salvar produto: ${insertErr.message}`);
  }

  // Criar aprovação para mesa
  await criarAprovacao("produto", produtoSalvo.id, codigo);

  const tempo = Date.now() - inicio;
  await logIA(
    "produto-agent",
    membro_id,
    "api",
    descricao,
    JSON.stringify(classificacao),
    "classificar_produto",
    "produto_classificado",
    true,
    tempo
  );

  return jsonResponse({
    sucesso: true,
    produto: produtoSalvo,
    classificacao,
  });
}

// ---------------------------------------------------------------------------
// Ação: buscar_match
// ---------------------------------------------------------------------------

async function handleBuscarMatch(especificacao: Record<string, unknown>) {
  const { data: produtos, error } = await supabase
    .from("produtos")
    .select("*")
    .eq("status", "aprovado");

  if (error) {
    throw new Error(`Erro ao buscar produtos: ${error.message}`);
  }

  if (!produtos || produtos.length === 0) {
    return jsonResponse({ sucesso: true, matches: [], total: 0 });
  }

  // Construir tags da especificação para comparação
  const tagsEspec: string[] = [];

  // Extrair tags de vários campos da especificação
  if (especificacao.categoria) tagsEspec.push(String(especificacao.categoria).toLowerCase());
  if (especificacao.subcategoria) tagsEspec.push(String(especificacao.subcategoria).toLowerCase());
  if (especificacao.produto) tagsEspec.push(String(especificacao.produto).toLowerCase());

  if (Array.isArray(especificacao.tags)) {
    tagsEspec.push(...especificacao.tags.map((t: unknown) => String(t).toLowerCase()));
  }

  // Incluir valores de especificações adicionais como tags
  if (especificacao.especificacoes && typeof especificacao.especificacoes === "object") {
    for (const val of Object.values(especificacao.especificacoes as Record<string, unknown>)) {
      if (val) tagsEspec.push(String(val).toLowerCase());
    }
  }

  // Calcular score de match por overlap de tags
  const matches = produtos
    .map((p: { tags?: string[]; [key: string]: unknown }) => {
      const prodTags = (p.tags || []).map((t: string) => t.toLowerCase());
      const overlap = tagsEspec.filter((t) => prodTags.includes(t));
      const score =
        tagsEspec.length > 0
          ? overlap.length / tagsEspec.length
          : 0;

      return {
        ...p,
        score: Math.round(score * 100) / 100,
        tags_match: overlap,
      };
    })
    .filter((m: { score: number }) => m.score > 0)
    .sort((a: { score: number }, b: { score: number }) => b.score - a.score)
    .slice(0, 10);

  return jsonResponse({ sucesso: true, matches, total: matches.length });
}

// ---------------------------------------------------------------------------
// Ação: aprovar
// ---------------------------------------------------------------------------

async function handleAprovar(produto_id: string, membro_id: string) {
  const agora = new Date().toISOString();

  const { error: updErr } = await supabase
    .from("produtos")
    .update({
      status: "aprovado",
      aprovado_por: membro_id,
      aprovado_em: agora,
    })
    .eq("id", produto_id);

  if (updErr) {
    throw new Error(`Erro ao aprovar produto: ${updErr.message}`);
  }

  // Atualizar registro de aprovação
  await supabase
    .from("aprovacoes")
    .update({
      status: "aprovado",
      aprovado_por: membro_id,
      aprovado_em: agora,
    })
    .eq("tipo", "produto")
    .eq("entidade_id", produto_id)
    .eq("status", "pendente");

  // Buscar produto para notificar o fornecedor
  const { data: produto } = await supabase
    .from("produtos")
    .select("criado_por, codigo, nome_normalizado")
    .eq("id", produto_id)
    .single();

  if (produto?.criado_por) {
    await supabase.from("notificacoes_v2").insert({
      member_id: produto.criado_por,
      tipo: "produto_aprovado",
      titulo: "Produto aprovado",
      mensagem: `Seu produto ${produto.codigo} — ${produto.nome_normalizado} foi aprovado e está disponível no catálogo.`,
      canal: "dashboard",
      acao_requerida: false,
      criado_em: agora,
    });
  }

  return jsonResponse({ sucesso: true, produto_id, status: "aprovado" });
}

// ---------------------------------------------------------------------------
// Ação: rejeitar
// ---------------------------------------------------------------------------

async function handleRejeitar(produto_id: string, membro_id: string, motivo: string) {
  const agora = new Date().toISOString();

  const { error: updErr } = await supabase
    .from("produtos")
    .update({
      status: "rejeitado",
      motivo_rejeicao: motivo,
    })
    .eq("id", produto_id);

  if (updErr) {
    throw new Error(`Erro ao rejeitar produto: ${updErr.message}`);
  }

  // Atualizar registro de aprovação
  await supabase
    .from("aprovacoes")
    .update({
      status: "rejeitado",
      aprovado_por: membro_id,
      aprovado_em: agora,
      motivo_rejeicao: motivo,
    })
    .eq("tipo", "produto")
    .eq("entidade_id", produto_id)
    .eq("status", "pendente");

  // Notificar fornecedor com motivo
  const { data: produto } = await supabase
    .from("produtos")
    .select("criado_por, codigo, nome_normalizado")
    .eq("id", produto_id)
    .single();

  if (produto?.criado_por) {
    await supabase.from("notificacoes_v2").insert({
      member_id: produto.criado_por,
      tipo: "produto_rejeitado",
      titulo: "Produto rejeitado",
      mensagem: `Seu produto ${produto.codigo} — ${produto.nome_normalizado} foi rejeitado. Motivo: ${motivo}`,
      canal: "dashboard",
      acao_requerida: false,
      criado_em: agora,
    });
  }

  return jsonResponse({ sucesso: true, produto_id, status: "rejeitado", motivo });
}

// ---------------------------------------------------------------------------
// Ação: reclassificar
// ---------------------------------------------------------------------------

async function handleReclassificar(produto_id: string) {
  const inicio = Date.now();

  // Buscar produto existente
  const { data: produto, error: fetchErr } = await supabase
    .from("produtos")
    .select("*")
    .eq("id", produto_id)
    .single();

  if (fetchErr || !produto) {
    throw new Error(`Produto ${produto_id} não encontrado`);
  }

  const descricao = produto.descricao_livre;
  if (!descricao) {
    throw new Error("Produto sem descrição livre para reclassificar");
  }

  const classificacao = await classificarDescricao(descricao);

  const { error: updErr } = await supabase
    .from("produtos")
    .update({
      categoria: classificacao.categoria,
      subcategoria: classificacao.subcategoria,
      nome_normalizado: classificacao.nome_normalizado,
      tags: classificacao.tags,
      variacoes: classificacao.variacoes,
      campos_relevantes: classificacao.campos_relevantes,
      confianca: classificacao.confianca,
      status: "revisado_ia",
      revisado_por_ia: true,
      atualizado_em: new Date().toISOString(),
    })
    .eq("id", produto_id);

  if (updErr) {
    throw new Error(`Erro ao atualizar produto: ${updErr.message}`);
  }

  const tempo = Date.now() - inicio;
  await logIA(
    "produto-agent",
    produto.criado_por,
    "api",
    descricao,
    JSON.stringify(classificacao),
    "reclassificar_produto",
    "produto_reclassificado",
    true,
    tempo
  );

  return jsonResponse({
    sucesso: true,
    produto_id,
    classificacao,
  });
}

// ---------------------------------------------------------------------------
// Handler principal
// ---------------------------------------------------------------------------

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return corsResponse();
  }

  if (req.method !== "POST") {
    return jsonResponse({ erro: "Método não permitido. Use POST." }, 405);
  }

  const inicio = Date.now();

  try {
    const body: ProdutoRequest = await req.json();
    const { acao } = body;

    if (!acao) {
      return jsonResponse({ erro: "Campo 'acao' é obrigatório" }, 400);
    }

    switch (acao) {
      case "classificar": {
        if (!body.descricao || !body.membro_id) {
          return jsonResponse(
            { erro: "Campos 'descricao' e 'membro_id' são obrigatórios para classificar" },
            400
          );
        }
        return await handleClassificar(body.descricao, body.membro_id);
      }

      case "buscar_match": {
        if (!body.especificacao) {
          return jsonResponse(
            { erro: "Campo 'especificacao' é obrigatório para buscar_match" },
            400
          );
        }
        return await handleBuscarMatch(body.especificacao);
      }

      case "aprovar": {
        if (!body.produto_id) {
          return jsonResponse(
            { erro: "Campo 'produto_id' é obrigatório para aprovar" },
            400
          );
        }
        return await handleAprovar(body.produto_id, body.membro_id || "sistema");
      }

      case "rejeitar": {
        if (!body.produto_id || !body.motivo) {
          return jsonResponse(
            { erro: "Campos 'produto_id' e 'motivo' são obrigatórios para rejeitar" },
            400
          );
        }
        return await handleRejeitar(body.produto_id, body.membro_id || "sistema", body.motivo);
      }

      case "reclassificar": {
        if (!body.produto_id) {
          return jsonResponse(
            { erro: "Campo 'produto_id' é obrigatório para reclassificar" },
            400
          );
        }
        return await handleReclassificar(body.produto_id);
      }

      default:
        return jsonResponse(
          { erro: `Ação '${acao}' desconhecida. Use: classificar, buscar_match, aprovar, rejeitar, reclassificar` },
          400
        );
    }
  } catch (err) {
    const tempo = Date.now() - inicio;
    const mensagem = err instanceof Error ? err.message : String(err);

    // Log de erro
    await logIA(
      "produto-agent",
      null,
      "api",
      "",
      mensagem,
      "erro",
      "erro",
      false,
      tempo
    ).catch(() => {});

    return jsonResponse({ erro: mensagem }, 500);
  }
});
