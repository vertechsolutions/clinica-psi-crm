/**
 * Cliente mínimo da WhatsApp Cloud API (Graph API). Só o necessário pra um bot de
 * atendimento reativo: enviar texto, marcar como lida e mostrar "digitando".
 * Docs: https://developers.facebook.com/documentation/business-messaging/whatsapp
 */
import crypto from 'node:crypto';

const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION || 'v25.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

const TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const APP_SECRET = process.env.WHATSAPP_APP_SECRET;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

/** true quando dá pra enviar mensagens (token + phone id presentes). */
export const canSend = Boolean(TOKEN && PHONE_ID);

export function getVerifyToken(): string | undefined {
  return VERIFY_TOKEN;
}

/**
 * Valida a assinatura X-Hub-Signature-256: HMAC-SHA256 do RAW body com o App
 * Secret. Precisa dos bytes crus recebidos (não do JSON re-serializado).
 * Fail-closed: sem App Secret configurado, RECUSA tudo (não dá pra confiar na
 * origem). O App Secret é obrigatório pro webhook aceitar mensagens.
 */
export function isValidSignature(rawBody: string, signatureHeader: string | null): boolean {
  if (!APP_SECRET) {
    console.error('[whatsapp] WHATSAPP_APP_SECRET ausente — webhook recusando todas as requisições.');
    return false;
  }
  if (!signatureHeader) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(rawBody).digest('hex');
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function graphPost(body: unknown): Promise<void> {
  if (!canSend) {
    console.warn('[whatsapp] envio ignorado — WHATSAPP_TOKEN/PHONE_NUMBER_ID ausentes.');
    return;
  }
  const res = await fetch(`${GRAPH_BASE}/${PHONE_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // loga só código/mensagem do erro (nunca o corpo cru, que pode ter telefone do
    // paciente) e propaga pro caller decidir — o after() do webhook loga no catch.
    const j = (await res.json().catch(() => ({}))) as { error?: { code?: number; message?: string } };
    throw new Error(`Graph API ${res.status} code=${j?.error?.code ?? '?'} ${j?.error?.message ?? ''}`.trim());
  }
}

/** Envia uma mensagem de texto. `to` é o wa_id que a Meta mandou no webhook. */
export function sendText(to: string, body: string): Promise<void> {
  return graphPost({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { preview_url: false, body },
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Envia várias mensagens em sequência (bolhas separadas), com um respiro entre
 * elas pra parecer uma pessoa digitando. Usado com splitReply(). Se uma parte
 * falha, propaga (o webhook loga e não persiste) — parte já enviada fica no chat.
 */
export async function sendTextSequence(to: string, parts: string[], delayMs = 900): Promise<void> {
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]?.trim();
    if (!p) continue;
    await sendText(to, p);
    if (i < parts.length - 1) await sleep(delayMs);
  }
}

/**
 * Marca a mensagem como lida e liga o indicador "digitando". O typing some em 25s
 * ou quando a próxima mensagem é enviada — chame logo ao receber. Falha aqui não
 * deve travar o fluxo (best-effort).
 */
export async function markReadAndType(messageId: string): Promise<void> {
  try {
    await graphPost({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
      typing_indicator: { type: 'text' },
    });
  } catch (err) {
    console.error('[whatsapp] markReadAndType falhou', err);
  }
}

/**
 * Baixa uma mídia (áudio/imagem/documento) do WhatsApp. A Graph API exige dois
 * passos: primeiro GET /{media_id} pra pegar a URL assinada (curta duração),
 * depois GET nessa URL com o mesmo Bearer token pra pegar os bytes.
 * Docs: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media
 *
 * Retorna null se o download falhar (best-effort — chamador decide como reagir).
 */
export async function downloadMedia(
  mediaId: string,
): Promise<{ bytes: Buffer; mimeType: string } | null> {
  if (!TOKEN) {
    console.warn('[whatsapp] downloadMedia ignorado — WHATSAPP_TOKEN ausente.');
    return null;
  }
  try {
    // 1) resolve a URL da mídia
    const meta = await fetch(`${GRAPH_BASE}/${mediaId}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    if (!meta.ok) {
      throw new Error(`meta ${meta.status}`);
    }
    const info = (await meta.json()) as { url?: string; mime_type?: string };
    if (!info.url) throw new Error('sem url na resposta');

    // 2) baixa os bytes (mesmo Bearer)
    const media = await fetch(info.url, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    if (!media.ok) {
      throw new Error(`media ${media.status}`);
    }
    const buf = Buffer.from(await media.arrayBuffer());
    const mimeType = info.mime_type || media.headers.get('content-type') || 'application/octet-stream';
    return { bytes: buf, mimeType };
  } catch (err) {
    console.error('[whatsapp] downloadMedia falhou', err);
    return null;
  }
}

/**
 * Envia uma notificação interna pra equipe (Bruna, atendentes, dev) sem quebrar
 * o fluxo do paciente. Falha silenciosa: se der ruim, apenas loga.
 * `to` deve ser wa_id no formato E.164 sem "+" (ex.: "5527981178233").
 */
export async function sendInternalAlert(to: string, body: string): Promise<void> {
  try {
    await sendText(to, body);
  } catch (err) {
    console.error(`[whatsapp] alerta interno pra ${to} falhou`, err);
  }
}
