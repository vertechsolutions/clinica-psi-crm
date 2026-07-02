import { after } from 'next/server';
import { getVerifyToken, isValidSignature, markReadAndType, sendText } from '@/lib/whatsapp';
import { recordUserMessage, computeReply, persistReply } from '@/lib/conversation';
import { hasDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Pedido a quem manda audio/midia - a clinica atende por texto no primeiro contato.
const PEDE_TEXTO =
  'Oi! Consigo te ajudar melhor por aqui escrevendo. Pode me mandar por texto o que voce precisa? 🙂';

// Verificacao do webhook (Meta chama ao configurar o Callback URL no App Dashboard).
// Responde o hub.challenge cru quando o verify_token bate.
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  if (mode === 'subscribe' && token && token === getVerifyToken()) {
    return new Response(challenge ?? '', { status: 200 });
  }
  return new Response('Forbidden', { status: 403 });
}

// Recebe eventos do WhatsApp. Valida a assinatura, ignora status de entrega, e
// processa a mensagem do usuario DEPOIS de responder 200 (via after()).
export async function POST(req: Request): Promise<Response> {
  const raw = await req.text();

  if (!isValidSignature(raw, req.headers.get('x-hub-signature-256'))) {
    return new Response('Invalid signature', { status: 401 });
  }

  let payload: WebhookPayload;
  try {
    payload = JSON.parse(raw) as WebhookPayload;
  } catch {
    return new Response('Bad JSON', { status: 400 });
  }

  const value = payload.entry?.[0]?.changes?.[0]?.value;
  const msg = value?.messages?.[0];

  // status de entrega (sent/delivered/read) ou evento sem mensagem: nada a fazer
  if (!msg) return new Response('ok', { status: 200 });

  // sem banco nao ha como manter contexto nem deduplicar: aceita e loga
  if (!hasDb) {
    console.warn('[webhook] mensagem recebida mas DATABASE_URL ausente - ignorada.');
    return new Response('ok', { status: 200 });
  }

  const from = msg.from;
  const wamid = msg.id;
  const nome = value?.contacts?.[0]?.profile?.name;

  after(async () => {
    try {
      if (msg.type === 'text') {
        const texto = msg.text?.body?.trim();
        if (!texto) return;
        const isNew = await recordUserMessage(from, texto, wamid);
        if (!isNew) return;
        await markReadAndType(wamid);
        const turno = await computeReply(from);
        await sendText(from, turno.resposta);
        await persistReply(from, nome, turno);
      } else {
        const isNew = await recordUserMessage(from, `[${msg.type}]`, wamid);
        if (!isNew) return;
        await markReadAndType(wamid);
        await sendText(from, PEDE_TEXTO);
      }
    } catch (err) {
      console.error('[webhook] erro ao processar mensagem', err);
    }
  });

  return new Response('ok', { status: 200 });
}

interface WebhookPayload {
  entry?: Array<{
    changes?: Array<{
      value?: {
        contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
        messages?: Array<{
          from: string;
          id: string;
          type: string;
          text?: { body?: string };
        }>;
        statuses?: unknown[];
      };
    }>;
  }>;
}
