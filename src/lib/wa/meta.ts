/**
 * Provider da WhatsApp Cloud API (Graph API) da Meta. Foi o transporte do piloto
 * até 08/2026, quando o número oficial da clínica passou pra Z-API — fica aqui
 * inteiro e funcional pra que voltar seja `WA_PROVIDER=meta`, não um rollback.
 * Docs: https://developers.facebook.com/documentation/business-messaging/whatsapp
 */
import crypto from 'node:crypto';
import {
  normalizarWaId,
  type Midia,
  type MidiaRef,
  type MensagemRecebida,
  type RequisicaoWebhook,
  type TipoMensagem,
  type WaProvider,
} from './types';

const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION || 'v25.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

const TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const APP_SECRET = process.env.WHATSAPP_APP_SECRET;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

const canSend = Boolean(TOKEN && PHONE_ID);

/** POST no /messages. Devolve o id da mensagem criada (pra reconhecer o eco). */
async function graphPost(body: unknown): Promise<string | null> {
  if (!canSend) {
    console.warn('[meta] envio ignorado — WHATSAPP_TOKEN/PHONE_NUMBER_ID ausentes.');
    return null;
  }
  const res = await fetch(`${GRAPH_BASE}/${PHONE_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // loga só código/mensagem do erro (nunca o corpo cru, que pode ter telefone do
    // paciente) e propaga pro caller decidir — o after() do webhook loga no catch.
    const j = (await res.json().catch(() => ({}))) as { error?: { code?: number; message?: string } };
    throw new Error(`Graph API ${res.status} code=${j?.error?.code ?? '?'} ${j?.error?.message ?? ''}`.trim());
  }
  const ok = (await res.json().catch(() => ({}))) as { messages?: Array<{ id?: string }> };
  return ok?.messages?.[0]?.id ?? null;
}

// ---- tipos mínimos do payload da Meta que a gente usa ----
interface WebhookMessage {
  from: string;
  id: string;
  type: string;
  text?: { body?: string };
  audio?: { id?: string; mime_type?: string; voice?: boolean };
  voice?: { id?: string; mime_type?: string };
  image?: { id?: string; mime_type?: string; caption?: string };
  document?: { id?: string; mime_type?: string; filename?: string; caption?: string };
}

interface WebhookPayload {
  entry?: Array<{
    changes?: Array<{
      value?: {
        contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
        messages?: WebhookMessage[];
        statuses?: unknown[];
      };
    }>;
  }>;
}

function tipoDe(t: string): TipoMensagem {
  if (t === 'text') return 'text';
  if (t === 'audio' || t === 'voice') return 'audio';
  if (t === 'image') return 'image';
  if (t === 'document') return 'document';
  return 'outro';
}

export const metaProvider: WaProvider = {
  nome: 'meta',
  canSend,
  precisaTemplate: true,

  verifyChallenge(url) {
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    if (mode === 'subscribe' && token && VERIFY_TOKEN && token === VERIFY_TOKEN) {
      return url.searchParams.get('hub.challenge') ?? '';
    }
    return null;
  },

  /**
   * X-Hub-Signature-256: HMAC-SHA256 do RAW body com o App Secret. Precisa dos
   * bytes crus recebidos (não do JSON re-serializado). Fail-closed: sem App
   * Secret configurado, RECUSA tudo.
   */
  autenticar(raw, req: RequisicaoWebhook) {
    if (!APP_SECRET) {
      console.error('[meta] WHATSAPP_APP_SECRET ausente — webhook recusando todas as requisições.');
      return false;
    }
    const signatureHeader = req.headers.get('x-hub-signature-256');
    if (!signatureHeader) return false;
    const expected = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex');
    const a = Buffer.from(signatureHeader);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  },

  parse(raw) {
    let payload: WebhookPayload;
    try {
      payload = JSON.parse(raw) as WebhookPayload;
    } catch {
      return [];
    }
    const value = payload.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];
    if (!msg?.from || !msg.id) return [];

    const tipo = tipoDe(msg.type);
    const midia: MidiaRef | undefined =
      tipo === 'audio'
        ? { id: msg.audio?.id || msg.voice?.id, mimeType: msg.audio?.mime_type || msg.voice?.mime_type }
        : tipo === 'image'
          ? { id: msg.image?.id, mimeType: msg.image?.mime_type }
          : tipo === 'document'
            ? { id: msg.document?.id, mimeType: msg.document?.mime_type }
            : undefined;

    const out: MensagemRecebida = {
      waId: normalizarWaId(msg.from),
      messageId: msg.id,
      tipo,
      texto: msg.text?.body?.trim() || undefined,
      legenda: (msg.image?.caption || msg.document?.caption)?.trim() || undefined,
      midia,
      nome: value?.contacts?.[0]?.profile?.name,
      // a Cloud API não entrega o que a clínica manda pelo app: sempre entrante
      fromMe: false,
      isGroup: false,
      tipoCru: msg.type,
    };
    return [out];
  },

  sendText(to, body) {
    return graphPost({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: false, body },
    });
  },

  /**
   * Marca lida + liga o "digitando" num POST só. O typing some em 25s ou quando
   * a próxima mensagem sai. Falha aqui não trava o fluxo (best-effort).
   */
  async markReadAndType({ messageId }) {
    try {
      await graphPost({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
        typing_indicator: { type: 'text' },
      });
    } catch (err) {
      console.error('[meta] markReadAndType falhou', err);
    }
  },

  /**
   * Dois passos: GET /{media_id} pra pegar a URL assinada (curta duração),
   * depois GET nessa URL com o mesmo Bearer. null em falha (best-effort).
   */
  async downloadMedia(ref) {
    if (!ref.id) return null;
    if (!TOKEN) {
      console.warn('[meta] downloadMedia ignorado — WHATSAPP_TOKEN ausente.');
      return null;
    }
    try {
      const meta = await fetch(`${GRAPH_BASE}/${ref.id}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      if (!meta.ok) throw new Error(`meta ${meta.status}`);
      const info = (await meta.json()) as { url?: string; mime_type?: string };
      if (!info.url) throw new Error('sem url na resposta');

      const media = await fetch(info.url, { headers: { Authorization: `Bearer ${TOKEN}` } });
      if (!media.ok) throw new Error(`media ${media.status}`);
      const out: Midia = {
        bytes: Buffer.from(await media.arrayBuffer()),
        mimeType:
          info.mime_type || ref.mimeType || media.headers.get('content-type') || 'application/octet-stream',
      };
      return out;
    } catch (err) {
      console.error('[meta] downloadMedia falhou', err);
      return null;
    }
  },

  /**
   * Template aprovado (Message Template). Necessário pra falar com um contato
   * FORA da janela de 24h. Sem variáveis no corpo (o texto vive na Meta).
   */
  sendTemplate(to, name, lang = 'pt_BR') {
    return graphPost({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template: { name, language: { code: lang } },
    });
  },
};
