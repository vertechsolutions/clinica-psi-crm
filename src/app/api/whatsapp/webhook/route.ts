import { after } from 'next/server';
import { getVerifyToken, isValidSignature, markReadAndType, sendText } from '@/lib/whatsapp';
import { recordUserMessage, computeReply, persistReply, type TurnoResposta } from '@/lib/conversation';
import { hasDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Pedido a quem manda áudio/mídia — a clínica atende por texto no primeiro contato. */
const PEDE_TEXTO =
  'Oi! Consigo te ajudar melhor por aqui escrevendo. Pode me mandar por texto o que você precisa? 🙂';
const FALHA_TEMPORARIA =
  'Tive uma instabilidade aqui agora. Pode me mandar a mensagem de novo em alguns segundos?';

async function sendFallback(to: string, err: unknown): Promise<void> {
  console.error('[webhook] erro ao gerar resposta', err);
  try {
    await sendText(to, FALHA_TEMPORARIA);
  } catch (fallbackErr) {
    console.error('[webhook] erro ao enviar fallback', fallbackErr);
  }
}

/**
 * Verificação do webhook (Meta chama ao configurar o Callback URL no App Dashboard).
 * Responde o hub.challenge cru quando o verify_token bate.
 */
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

/**
 * Recebe eventos do WhatsApp. Valida a assinatura, ignora status de entrega, e
 * processa a mensagem do usuário DEPOIS de responder 200 (via after()) — a Meta
 * reenvia se não receber 200 rápido, e a dedup por wamid cobre reentregas.
 *
 * Limitação conhecida (aceitável no piloto): a dedup cobre reentregas da Meta,
 * mas não um crash do processo no meio do after() (após o 200). Nesse caso raro,
 * a mensagem do usuário fica gravada sem resposta. Pra volume de clínica pequena
 * o risco é baixo; uma fila durável (Redis/Postgres job) resolveria numa evolução.
 */
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

  // sem banco não há como manter contexto nem deduplicar: aceita e loga
  if (!hasDb) {
    console.warn('[webhook] mensagem recebida mas DATABASE_URL ausente — ignorada.');
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
        if (!isNew) return; // reentrega da Meta: já processada
        await markReadAndType(wamid);
        let turno: TurnoResposta;
        try {
          turno = await computeReply(from);
        } catch (err) {
          await sendFallback(from, err);
          return;
        }
        await sendText(from, turno.resposta); // se falhar, lança e não persiste a resposta
        try {
          await persistReply(from, nome, turno); // grava só depois de entregar
        } catch (err) {
          console.error('[webhook] erro ao persistir resposta', err);
        }
      } else {
        // áudio/imagem/documento/etc: dedup pelo wamid e pede texto
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

// ---- tipos mínimos do payload do WhatsApp que a gente usa ----
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
