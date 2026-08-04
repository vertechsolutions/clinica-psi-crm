/**
 * Provider da Z-API — API não-oficial que pareia o WhatsApp da clínica por QR
 * code (mesmo princípio do WhatsApp Web). Escolhida porque o número profissional
 * da Bruna CONTINUA no celular dela: a Camila atende, e quando a Bruna entra na
 * conversa pelo app a gente fica sabendo (eco `fromMe`) e cala a IA.
 *
 * Diferenças que importam em relação à Cloud API:
 * - não existe janela de 24h nem template aprovado (envio livre);
 * - mídia vem como URL direta (um hop, sem Bearer);
 * - o webhook NÃO é assinado pela Z-API: a autenticação aqui é um segredo nosso
 *   na URL/header (`ZAPI_WEBHOOK_SECRET`), fail-closed;
 * - o que sai do número (inclusive o que a Bruna digita no celular) volta pra
 *   gente com `fromMe: true`.
 *
 * Docs: https://developer.z-api.io
 */
import crypto from 'node:crypto';
import {
  normalizarWaId,
  type Midia,
  type MensagemRecebida,
  type RequisicaoWebhook,
  type TipoMensagem,
  type WaProvider,
} from './types';

const INSTANCE = process.env.ZAPI_INSTANCE_ID;
const TOKEN = process.env.ZAPI_INSTANCE_TOKEN;
const CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN;
const WEBHOOK_SECRET = process.env.ZAPI_WEBHOOK_SECRET;

const BASE = `https://api.z-api.io/instances/${INSTANCE}/token/${TOKEN}`;
const canSend = Boolean(INSTANCE && TOKEN);

/** "digitando" antes de cada bolha (1–15s). 1s dá o indicador sem atrasar. */
const DELAY_TYPING = 1;

async function zapiPost(path: string, body: unknown): Promise<Record<string, unknown> | null> {
  if (!canSend) {
    console.warn('[zapi] envio ignorado — ZAPI_INSTANCE_ID/ZAPI_INSTANCE_TOKEN ausentes.');
    return null;
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  // Client-Token é a trava de segurança da conta: quando ligada no painel, toda
  // requisição sem ela é recusada.
  if (CLIENT_TOKEN) headers['Client-Token'] = CLIENT_TOKEN;

  const res = await fetch(`${BASE}/${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    // nunca loga o corpo cru (tem telefone do paciente) — só status e o campo error
    const j = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new Error(`Z-API ${path} ${res.status} ${j?.error || j?.message || ''}`.trim());
  }
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

// ---- payload do webhook "ao receber" (plano, um evento por chamada) ----
interface ZapiWebhook {
  phone?: string;
  fromMe?: boolean;
  messageId?: string;
  senderName?: string;
  chatName?: string;
  momment?: number;
  isGroup?: boolean;
  instanceId?: string;
  type?: string;
  connected?: boolean;
  text?: { message?: string };
  image?: { imageUrl?: string; caption?: string; mimeType?: string };
  audio?: { audioUrl?: string; mimeType?: string };
  document?: { documentUrl?: string; fileName?: string; mimeType?: string; caption?: string };
  video?: unknown;
  sticker?: unknown;
  contact?: unknown;
  location?: unknown;
}

/** Rótulo cru do tipo, pro histórico ("[sticker]") quando não tratamos a mídia. */
function tipoCruDe(p: ZapiWebhook): string {
  for (const k of ['text', 'image', 'audio', 'document', 'video', 'sticker', 'contact', 'location'] as const) {
    if (p[k]) return k;
  }
  return p.type || 'desconhecido';
}

function tipoDe(p: ZapiWebhook): TipoMensagem {
  if (p.text?.message) return 'text';
  if (p.audio) return 'audio';
  if (p.image) return 'image';
  if (p.document) return 'document';
  return 'outro';
}

/** Comparação de segredo em tempo constante (evita descobrir o token por timing). */
function segredoConfere(recebido: string | null): boolean {
  if (!recebido || !WEBHOOK_SECRET) return false;
  const a = Buffer.from(recebido);
  const b = Buffer.from(WEBHOOK_SECRET);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export const zapiProvider: WaProvider = {
  nome: 'zapi',
  canSend,
  precisaTemplate: false,

  // a Z-API não faz handshake por GET — a URL é colada no painel da instância
  verifyChallenge() {
    return null;
  },

  /**
   * A Z-API não assina o webhook (o Client-Token protege as chamadas que NÓS
   * fazemos, não o caminho inverso). Então a porta é um segredo nosso, aceito
   * na query (`?s=...`, que é como se cola a URL no painel) ou no header
   * `x-webhook-secret`. Fail-closed: sem `ZAPI_WEBHOOK_SECRET`, recusa tudo —
   * webhook aberto deixa qualquer um injetar mensagem falsa na Camila.
   */
  autenticar(_raw, req: RequisicaoWebhook) {
    if (!WEBHOOK_SECRET) {
      console.error('[zapi] ZAPI_WEBHOOK_SECRET ausente — webhook recusando todas as requisições.');
      return false;
    }
    return segredoConfere(req.url.searchParams.get('s') || req.headers.get('x-webhook-secret'));
  },

  parse(raw) {
    let p: ZapiWebhook;
    try {
      p = JSON.parse(raw) as ZapiWebhook;
    } catch {
      return [];
    }
    // eventos de status/entrega/conexão não têm phone+messageId de conversa
    if (!p.phone || !p.messageId) return [];
    // grupo não é atendimento: a clínica não conversa com paciente em grupo
    if (p.isGroup) return [];
    // instância errada = chamada que não é da nossa conta
    if (INSTANCE && p.instanceId && p.instanceId !== INSTANCE) {
      console.warn('[zapi] evento de outra instância ignorado.');
      return [];
    }

    const tipo = tipoDe(p);
    const out: MensagemRecebida = {
      waId: normalizarWaId(p.phone),
      messageId: p.messageId,
      tipo,
      texto: p.text?.message?.trim() || undefined,
      legenda: (p.image?.caption || p.document?.caption)?.trim() || undefined,
      midia:
        tipo === 'audio'
          ? { url: p.audio?.audioUrl, mimeType: p.audio?.mimeType }
          : tipo === 'image'
            ? { url: p.image?.imageUrl, mimeType: p.image?.mimeType }
            : tipo === 'document'
              ? { url: p.document?.documentUrl, mimeType: p.document?.mimeType }
              : undefined,
      nome: p.senderName || p.chatName || undefined,
      fromMe: p.fromMe === true,
      isGroup: false,
      tipoCru: tipoCruDe(p),
    };
    return [out];
  },

  async sendText(to, body) {
    const r = await zapiPost('send-text', {
      phone: normalizarWaId(to),
      message: body,
      delayTyping: DELAY_TYPING,
    });
    return (r?.messageId as string) || (r?.id as string) || null;
  },

  /**
   * Best-effort: a Z-API marca lida por mensagem; o "digitando" vai junto no
   * envio (`delayTyping`), então aqui só a leitura. Nunca lança.
   */
  async markReadAndType({ waId, messageId }) {
    try {
      await zapiPost('read-message', { phone: normalizarWaId(waId), messageId });
    } catch (err) {
      console.error('[zapi] read-message falhou', err);
    }
  },

  /** URL direta (a Z-API guarda a mídia por ~30 dias). Um hop, sem auth. */
  async downloadMedia(ref) {
    if (!ref.url) return null;
    try {
      const res = await fetch(ref.url);
      if (!res.ok) throw new Error(`media ${res.status}`);
      const out: Midia = {
        bytes: Buffer.from(await res.arrayBuffer()),
        mimeType: ref.mimeType || res.headers.get('content-type') || 'application/octet-stream',
      };
      return out;
    } catch (err) {
      console.error('[zapi] downloadMedia falhou', err);
      return null;
    }
  },

  /**
   * Não existe template aqui: sem janela de 24h, reengajamento é texto normal.
   * Se alguém chamar, é bug de fluxo — grita em vez de mandar algo errado.
   */
  async sendTemplate() {
    throw new Error('[zapi] sendTemplate não se aplica — a Z-API não tem janela de 24h nem template.');
  },
};
