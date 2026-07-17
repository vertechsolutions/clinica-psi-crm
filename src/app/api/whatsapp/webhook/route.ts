import { after } from 'next/server';
import {
  downloadMedia,
  getVerifyToken,
  isValidSignature,
  markReadAndType,
  sendInternalAlert,
  sendText,
  sendTextSequence,
} from '@/lib/whatsapp';
import {
  computeReply,
  isPaused,
  pauseConversation,
  persistReply,
  recordUserMessage,
} from '@/lib/conversation';
import { splitReply } from '@/lib/split-message';
import { transcribeAudio } from '@/lib/transcribe';
import { hasDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Fallback quando a transcrição falha ou o tipo de mídia não é suportado. */
const PEDE_TEXTO =
  'Oi! Não consegui ouvir seu áudio direito. Pode me mandar por texto o que você precisa? Assim consigo te ajudar melhor 🙂';
const PEDE_TEXTO_OUTRAS_MIDIAS =
  'Oi! Aqui pelo WhatsApp consigo te ajudar melhor por texto. Pode me contar por escrito? 🙂';
const FALHA_TEMPORARIA =
  'Tive uma instabilidade aqui agora. Pode me mandar a mensagem de novo em alguns segundos?';

/** Envia o aviso de instabilidade quando a geração da resposta falha (best-effort). */
async function sendFallback(to: string, err: unknown): Promise<void> {
  console.error('[webhook] erro ao gerar resposta', err);
  try {
    await sendText(to, FALHA_TEMPORARIA);
  } catch (fallbackErr) {
    console.error('[webhook] erro ao enviar fallback', fallbackErr);
  }
}

/**
 * Números que recebem alerta interno quando o formulário é enviado (fase de
 * testes). Ficam em env pra não hardcodar. Comma-separated, formato E.164 sem
 * "+" (ex.: "5527981178233,5549999551051").
 */
function alertRecipients(): string[] {
  const raw = process.env.NOTIFY_ALERT_NUMBERS || '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
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
 * Extrai o texto útil da mensagem recebida. Áudio é transcrito via Gemini e
 * volta como "[áudio transcrito]: ...". Imagem/documento viram um marcador de
 * anexo (a IA interpreta como comprovante no contexto de pagamento). Outros
 * tipos devolvem null e o webhook responde pedindo texto.
 */
async function extractText(msg: WebhookMessage): Promise<string | null> {
  if (msg.type === 'text') {
    return msg.text?.body?.trim() || null;
  }
  if (msg.type === 'audio' || msg.type === 'voice') {
    const mediaId = msg.audio?.id || msg.voice?.id;
    if (!mediaId) return null;
    const media = await downloadMedia(mediaId);
    if (!media) return null;
    const text = await transcribeAudio(media.bytes, media.mimeType);
    if (!text) return null;
    // marca no histórico que veio de áudio (útil pra revisão + a IA pode ler)
    return `[áudio transcrito]: ${text}`;
  }
  if (msg.type === 'image' || msg.type === 'document') {
    // Não "lemos" a imagem, mas sinalizamos pra Camila que chegou um anexo, com
    // a legenda se houver. No contexto de pagamento ela interpreta como o
    // comprovante e dispara o handoff (enviarForm); fora disso responde natural.
    const caption = (msg.image?.caption || msg.document?.caption)?.trim();
    const marca = '[o paciente enviou uma imagem/anexo pelo WhatsApp — se o pagamento acabou de ser combinado, é provavelmente o comprovante]';
    return caption ? `${marca} Legenda: ${caption}` : marca;
  }
  return null;
}

/**
 * Recebe eventos do WhatsApp. Valida a assinatura, ignora status de entrega, e
 * processa a mensagem DEPOIS de responder 200 (via after()) — a Meta reenvia se
 * não receber 200 rápido, e a dedup por wamid cobre reentregas.
 *
 * Limitação conhecida (aceitável no piloto): a dedup cobre reentregas da Meta,
 * mas não um crash do processo no meio do after(). Nesse caso raro, a mensagem
 * fica gravada sem resposta. Pra volume de clínica pequena o risco é baixo.
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

  if (!msg) return new Response('ok', { status: 200 });

  if (!hasDb) {
    console.warn('[webhook] mensagem recebida mas DATABASE_URL ausente — ignorada.');
    return new Response('ok', { status: 200 });
  }

  const from = msg.from;
  const wamid = msg.id;
  const nome = value?.contacts?.[0]?.profile?.name;

  after(async () => {
    try {
      // Handoff: se a conversa já foi pausada (form enviado), a IA fica muda pra
      // esse número. A equipe humana é quem assume daqui em diante. Ainda
      // gravamos a mensagem entrante pro histórico (útil pra Bruna revisar).
      const paused = await isPaused(from);

      const texto = await extractText(msg);

      if (texto == null) {
        // mídia que a gente não trata (áudio ilegível, sticker, vídeo, etc.)
        const isNew = await recordUserMessage(from, `[${msg.type}]`, wamid);
        if (!isNew) return;
        await markReadAndType(wamid);
        if (paused) return; // pausada: nem pede texto, deixa quieto
        const fallback = msg.type === 'audio' || msg.type === 'voice' ? PEDE_TEXTO : PEDE_TEXTO_OUTRAS_MIDIAS;
        await sendText(from, fallback);
        return;
      }

      const isNew = await recordUserMessage(from, texto, wamid);
      if (!isNew) return; // reentrega da Meta: já processada

      if (paused) {
        // grava a mensagem entrante mas NÃO responde — silêncio da IA é o
        // combinado. Loga pra Bruna ver que teve resposta do paciente.
        console.log(`[webhook] conversa ${from} pausada — mensagem gravada, IA silenciosa.`);
        return;
      }

      await markReadAndType(wamid);
      let turno: Awaited<ReturnType<typeof computeReply>>;
      try {
        turno = await computeReply(from);
      } catch (err) {
        await sendFallback(from, err);
        return;
      }
      // Entrega em bolhas: se a resposta trouxe parágrafos ou ficou longa, manda
      // 2–3 mensagens seguidas (UX de conversa). Se falhar, lança e não persiste.
      await sendTextSequence(from, splitReply(turno.resposta));
      try {
        await persistReply(from, nome, turno); // grava só depois de entregar
      } catch (err) {
        console.error('[webhook] erro ao persistir resposta', err);
      }

      // Handoff: IA sinalizou envio do form → pausa + notifica equipe.
      if (turno.enviarForm) {
        await pauseConversation(from);
        await notifyTeam(from, nome, turno);
      }
    } catch (err) {
      console.error('[webhook] erro ao processar mensagem', err);
    }
  });

  return new Response('ok', { status: 200 });
}

/** Manda alerta pra equipe (Bruna + dev em teste) com resumo da ficha do lead. */
async function notifyTeam(
  waId: string,
  nome: string | undefined,
  turno: Awaited<ReturnType<typeof computeReply>>,
): Promise<void> {
  const recipients = alertRecipients();
  if (recipients.length === 0) {
    console.warn('[webhook] NOTIFY_ALERT_NUMBERS não configurado — sem alerta.');
    return;
  }
  const lead = turno.lead;
  const linhas = [
    '🩵 *Novo formulário enviado — Cazule*',
    `Paciente: ${lead.nome || nome || '(sem nome)'}`,
    `WhatsApp: +${waId}`,
    lead.telefone ? `Telefone informado: ${lead.telefone}` : null,
    lead.email ? `E-mail: ${lead.email}` : null,
    lead.disponibilidade ? `Disponibilidade: ${lead.disponibilidade}` : null,
    lead.preferenciaAbordagem ? `Preferência: ${lead.preferenciaAbordagem}` : null,
    lead.resumo ? `Queixa: ${lead.resumo}` : lead.motivacao ? `Motivação: ${lead.motivacao}` : null,
    '',
    'A IA foi pausada nesse número. Assumam pelo WhatsApp da clínica.',
  ].filter(Boolean) as string[];
  const body = linhas.join('\n');
  await Promise.all(recipients.map((to) => sendInternalAlert(to, body)));
}

// ---- tipos mínimos do payload do WhatsApp que a gente usa ----
interface WebhookMessage {
  from: string;
  id: string;
  type: string;
  text?: { body?: string };
  audio?: { id?: string; mime_type?: string };
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
