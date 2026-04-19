/**
 * FoodHub — Email Agent
 *
 * Envia emails transacionais via Resend API.
 * Triggers: nova oportunidade, proposta recebida, deal fechado, NF pendente, deal parado.
 *
 * BLOQUEADOR: Precisa de RESEND_API_KEY configurada no .env.local
 * Criar conta em resend.com (gratuito 3k emails/mês)
 * Adicionar domínio brazilfoodhub.com no Resend
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

var RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";
var FROM_EMAIL = "mesa@brazilfoodhub.com";

interface EmailRequest {
  acao: string;
  para: string;
  nome: string;
  assunto: string;
  conteudo: string;
  botao_texto?: string;
  botao_url?: string;
}

function gerarHTML(nome: string, conteudo: string, botaoTexto?: string, botaoUrl?: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#050810;font-family:'DM Sans',system-ui,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#050810;padding:40px 20px">
<tr><td align="center">
<table width="100%" style="max-width:520px;background:#080D18;border:1px solid rgba(255,255,255,0.055);border-radius:16px;padding:36px 32px">
<tr><td align="center" style="padding-bottom:24px">
  <span style="font-size:32px;font-weight:700;color:#fff">Food</span><span style="font-size:32px;font-weight:700;color:#00C8FF">Hub</span><span style="display:inline-block;width:8px;height:8px;background:#00C8FF;border-radius:50%;margin-left:2px;vertical-align:super"></span>
  <div style="font-size:12px;color:#6b7a99;margin-top:4px;letter-spacing:0.5px">Mesa Nacional de Oportunidades</div>
</td></tr>
<tr><td style="padding-bottom:20px">
  <div style="font-size:15px;color:#e0e0e0;line-height:1.6">
    Ola ${nome},<br><br>
    ${conteudo}
  </div>
</td></tr>
${botaoTexto && botaoUrl ? `<tr><td align="center" style="padding:12px 0 24px">
  <a href="${botaoUrl}" style="display:inline-block;background:#00C8FF;color:#050810;padding:14px 32px;border-radius:10px;font-size:15px;font-weight:700;text-decoration:none;letter-spacing:0.3px">${botaoTexto}</a>
</td></tr>` : ""}
<tr><td align="center" style="border-top:1px solid rgba(255,255,255,0.055);padding-top:20px">
  <div style="font-size:11px;color:#3d4a63;font-style:italic">Acesso exclusivo — apenas convidados</div>
  <div style="font-size:11px;color:#3d4a63;margin-top:4px">brazilfoodhub.com</div>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

async function enviarEmail(para: string, assunto: string, html: string): Promise<{ok: boolean; error?: string}> {
  if (!RESEND_API_KEY) {
    return { ok: false, error: "RESEND_API_KEY nao configurada" };
  }

  var res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + RESEND_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "FoodHub <" + FROM_EMAIL + ">",
      to: [para],
      subject: "[FoodHub] " + assunto,
      html: html,
    }),
  });

  if (!res.ok) {
    var err = await res.text();
    return { ok: false, error: err };
  }

  return { ok: true };
}

// --- Templates por trigger ---

function emailNovaOportunidade(nome: string, produto: string, volume: string, regiao: string): { assunto: string; html: string } {
  return {
    assunto: "Nova oportunidade compativel com seu portfolio",
    html: gerarHTML(nome,
      `Uma nova oportunidade foi publicada na mesa:<br><br>` +
      `<strong>Produto:</strong> ${produto}<br>` +
      `<strong>Volume:</strong> ${volume}<br>` +
      `<strong>Regiao:</strong> ${regiao}<br><br>` +
      `Acesse sua vitrine para enviar uma proposta.`,
      "Ver Oportunidade", "https://brazilfoodhub.com/vitrine.html"
    ),
  };
}

function emailPropostaRecebida(nome: string, produto: string, industria: string, preco: string): { assunto: string; html: string } {
  return {
    assunto: "Nova proposta recebida para " + produto,
    html: gerarHTML(nome,
      `Voce recebeu uma nova proposta:<br><br>` +
      `<strong>Produto:</strong> ${produto}<br>` +
      `<strong>Industria:</strong> ${industria}<br>` +
      `<strong>Preco:</strong> R$ ${preco}<br><br>` +
      `Acesse suas demandas para avaliar e negociar.`,
      "Ver Propostas", "https://brazilfoodhub.com/demandas.html"
    ),
  };
}

function emailDealFechado(nome: string, produto: string, volume: string, total: string, codigo: string): { assunto: string; html: string } {
  return {
    assunto: "Deal fechado — " + codigo,
    html: gerarHTML(nome,
      `Um deal foi fechado com sucesso:<br><br>` +
      `<strong>Codigo:</strong> ${codigo}<br>` +
      `<strong>Produto:</strong> ${produto}<br>` +
      `<strong>Volume:</strong> ${volume}<br>` +
      `<strong>Total:</strong> R$ ${total}<br><br>` +
      `Acesse a plataforma para acompanhar o andamento.`,
      "Acompanhar Deal", "https://brazilfoodhub.com/carteira.html"
    ),
  };
}

function emailDealParado(nome: string, codigo: string, dias: number): { assunto: string; html: string } {
  return {
    assunto: "Deal " + codigo + " precisa de atencao",
    html: gerarHTML(nome,
      `O deal <strong>${codigo}</strong> esta parado ha <strong>${dias} dias</strong>.<br><br>` +
      `Verifique o status e tome as providencias necessarias.`,
      "Ver na Mesa", "https://brazilfoodhub.com/mesa.html"
    ),
  };
}

function emailNFPendente(nome: string, codigo: string): { assunto: string; html: string } {
  return {
    assunto: "Emita a NF do pedido " + codigo,
    html: gerarHTML(nome,
      `O deal <strong>${codigo}</strong> foi fechado.<br><br>` +
      `Por favor, emita a Nota Fiscal e envie pela plataforma.`,
      "Enviar NF", "https://brazilfoodhub.com/vitrine.html"
    ),
  };
}

// --- Handler ---

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type, Authorization" },
    });
  }

  try {
    var body: EmailRequest = await req.json();
    var { acao, para, nome, assunto, conteudo, botao_texto, botao_url } = body;

    var emailData: { assunto: string; html: string };

    switch (acao) {
      case "nova_oportunidade":
        emailData = emailNovaOportunidade(nome, body.conteudo, "", "");
        break;
      case "proposta_recebida":
        emailData = emailPropostaRecebida(nome, conteudo, "", "");
        break;
      case "deal_fechado":
        emailData = emailDealFechado(nome, conteudo, "", "", "");
        break;
      case "deal_parado":
        emailData = emailDealParado(nome, conteudo, 2);
        break;
      case "nf_pendente":
        emailData = emailNFPendente(nome, conteudo);
        break;
      case "custom":
        emailData = {
          assunto: assunto || "Notificacao FoodHub",
          html: gerarHTML(nome, conteudo, botao_texto, botao_url),
        };
        break;
      default:
        return new Response(JSON.stringify({ error: "Acao desconhecida: " + acao }), {
          status: 400, headers: { "Content-Type": "application/json" },
        });
    }

    var result = await enviarEmail(para, emailData.assunto, emailData.html);

    return new Response(JSON.stringify(result), {
      status: result.ok ? 200 : 500,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
});
