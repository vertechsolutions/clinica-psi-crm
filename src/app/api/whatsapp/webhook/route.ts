import { after } from 'next/server';
import {
  autenticarWebhook,
  downloadMedia,
  markReadAndType,
  parseWebhook,
  providerNome,
  sendInternalAlert,
  sendText,
  sendTextSequence,
  verifyChallenge,
  type MensagemRecebida,
} from '@/lib/whatsapp';
import {
  computeReply,
  foiNossoEnvio,
  isPaused,
  pauseConversation,
  persistReply,
  recordAssistantMessage,
  recordUserMessage,
  registrarEnvios,
} from '@/lib/conversation';
import { bolhasDoTurno } from '@/lib/fechamento';
import { transcribeAudio } from '@/lib/transcribe';
import { analisarComprovante } from '@/lib/comprovante';
import {
  chaveEsperada,
  mensagemAnexoInvalido,
  montarMarcadorComprovante,
  verificarDestinatario,
  type AnaliseComprovante,
  type VerificacaoDestinatario,
} from '@/lib/comprovante-core';
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
 * Trava de estreia. O transporte agora é o WhatsApp PROFISSIONAL da Bruna, que
 * já tem conversas em andamento — sem isto a Camila responderia todo mundo que
 * escrever, inclusive contato pessoal e paciente que já está sendo atendido por
 * ela. Com `WA_ALLOWLIST` preenchida, só esses números falam com a IA; os outros
 * são ignorados por completo (nem gravamos — dado de terceiro que não pediu
 * triagem não entra no banco). Vazia = atende todo mundo (operação normal).
 */
function allowlist(): string[] {
  return (process.env.WA_ALLOWLIST || '')
    .split(',')
    .map((s) => s.replace(/\D/g, ''))
    .filter(Boolean);
}

function atende(waId: string): boolean {
  const lista = allowlist();
  return lista.length === 0 || lista.includes(waId);
}

/**
 * Verificação do webhook por GET — a Meta chama ao configurar o Callback URL e
 * espera o hub.challenge cru de volta. A Z-API não faz handshake (a URL é colada
 * no painel da instância), então lá isto sempre responde 403.
 */
export async function GET(req: Request): Promise<Response> {
  const challenge = verifyChallenge(new URL(req.url));
  if (challenge !== null) return new Response(challenge, { status: 200 });
  return new Response('Forbidden', { status: 403 });
}

interface ExtractResult {
  texto: string | null;
  /** presente só quando a mensagem era imagem/documento (análise de comprovante) */
  comprovante?: { analise: AnaliseComprovante | null; verificacao: VerificacaoDestinatario };
}

/**
 * Extrai o texto útil da mensagem recebida. Áudio é transcrito via Gemini e
 * volta como "[áudio transcrito]: ...". Imagem/documento são ANALISADOS
 * (Gemini vision lê valor/destinatário do comprovante) e viram um marcador
 * rico com o veredito — em falha de análise, fail-open (marcador simples, a
 * equipe confere). Outros tipos devolvem null e o webhook pede texto.
 */
async function extractText(msg: MensagemRecebida): Promise<ExtractResult> {
  if (msg.tipo === 'text') {
    return { texto: msg.texto || null };
  }
  if (msg.tipo === 'audio') {
    if (!msg.midia) return { texto: null };
    const media = await downloadMedia(msg.midia);
    if (!media) return { texto: null };
    const text = await transcribeAudio(media.bytes, media.mimeType);
    if (!text) return { texto: null };
    // marca no histórico que veio de áudio (útil pra revisão + a IA pode ler)
    return { texto: `[áudio transcrito]: ${text}` };
  }
  if (msg.tipo === 'image' || msg.tipo === 'document') {
    let analise: AnaliseComprovante | null = null;
    if (msg.midia) {
      const media = await downloadMedia(msg.midia);
      if (media) analise = await analisarComprovante(media.bytes, media.mimeType || 'image/jpeg');
    }
    // PIX_INFO vai junto como titular: chaveEsperada() prioriza a PIX_CHAVE (só o
    // número), e sem o nome da clínica um comprovante com a chave mascarada pelo
    // banco viraria acusação de "pagou pro destinatário errado".
    const verificacao = analise
      ? verificarDestinatario(analise, chaveEsperada(), process.env.PIX_INFO)
      : 'inconclusivo';
    const marca = montarMarcadorComprovante(analise, verificacao);
    return {
      texto: msg.legenda ? `${marca} Legenda: ${msg.legenda}` : marca,
      comprovante: { analise, verificacao },
    };
  }
  return { texto: null };
}

/**
 * Eco de mensagem que SAIU do número da clínica (só a Z-API entrega isso). Duas
 * origens possíveis:
 * - a própria Camila (id registrado em `wa_outbound` no envio) → ignora, senão a
 *   IA se pausaria sozinha a cada resposta;
 * - a Bruna digitando no celular → a humana assumiu: grava no histórico e PAUSA
 *   a IA nesse número, pra não existirem duas vozes na mesma conversa.
 *
 * Só volta pela mão da equipe (`resumeConversation`) — é o mesmo estado do
 * handoff, e por isso a Camila não retoma sozinha depois.
 */
async function tratarEco(msg: MensagemRecebida): Promise<void> {
  if (await foiNossoEnvio(msg.messageId)) return;
  // Corrida: o eco pode chegar antes de o id do nosso envio estar gravado. Uma
  // segunda olhada depois de um respiro evita pausar a conversa por engano —
  // custo de um falso positivo aqui é a Camila emudecer sem ninguém ter assumido.
  await new Promise((r) => setTimeout(r, 2000));
  if (await foiNossoEnvio(msg.messageId)) return;
  const texto = msg.texto || `[${msg.tipoCru} enviado pela equipe]`;
  const isNew = await recordAssistantMessage(msg.waId, texto, msg.messageId);
  if (!isNew) return; // reentrega do mesmo eco
  const jaPausada = await isPaused(msg.waId);
  if (!jaPausada) {
    await pauseConversation(msg.waId);
    console.log(`[webhook] atendimento humano detectado em ${msg.waId} — IA pausada nesse número.`);
  }
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

  if (!autenticarWebhook(raw, { headers: req.headers, url: new URL(req.url) })) {
    return new Response('Invalid signature', { status: 401 });
  }

  const msg = parseWebhook(raw)[0];
  if (!msg) return new Response('ok', { status: 200 });

  if (!atende(msg.waId)) {
    // fora da allowlist da estreia: nem grava, nem responde (LGPD — é conversa
    // de terceiro que não pediu triagem). Loga mascarado só pra diagnóstico.
    console.log(`[webhook] número fora da WA_ALLOWLIST (***${msg.waId.slice(-4)}) — ignorado.`);
    return new Response('ok', { status: 200 });
  }

  if (!hasDb) {
    console.warn('[webhook] mensagem recebida mas DATABASE_URL ausente — ignorada.');
    return new Response('ok', { status: 200 });
  }

  // Saiu do número da clínica: ou é o eco da própria Camila, ou a Bruna assumiu
  // pelo celular. Nunca é um turno pra IA responder.
  if (msg.fromMe) {
    after(async () => {
      try {
        await tratarEco(msg);
      } catch (err) {
        console.error('[webhook] erro ao tratar eco', err);
      }
    });
    return new Response('ok', { status: 200 });
  }

  const from = msg.waId;
  const wamid = msg.messageId;
  const nome = msg.nome;

  after(async () => {
    try {
      // Handoff: se a conversa já foi pausada (form enviado), a IA fica muda pra
      // esse número. A equipe humana é quem assume daqui em diante. Ainda
      // gravamos a mensagem entrante pro histórico (útil pra Bruna revisar).
      const paused = await isPaused(from);

      const { texto, comprovante } = await extractText(msg);

      if (texto == null) {
        // mídia que a gente não trata (áudio ilegível, sticker, vídeo, etc.)
        const isNew = await recordUserMessage(from, `[${msg.tipoCru}]`, wamid);
        if (!isNew) return;
        await markReadAndType(msg);
        if (paused) return; // pausada: nem pede texto, deixa quieto
        const fallback = msg.tipo === 'audio' ? PEDE_TEXTO : PEDE_TEXTO_OUTRAS_MIDIAS;
        const id = await sendText(from, fallback);
        if (id) await registrarEnvios([id]);
        return;
      }

      const isNew = await recordUserMessage(from, texto, wamid);
      if (!isNew) return; // reentrega do provider: já processada

      if (paused) {
        // grava a mensagem entrante mas NÃO responde — silêncio da IA é o
        // combinado. Loga pra Bruna ver que teve resposta do paciente.
        console.log(`[webhook] conversa ${from} pausada — mensagem gravada, IA silenciosa.`);
        return;
      }

      await markReadAndType(msg);
      let turno: Awaited<ReturnType<typeof computeReply>>;
      try {
        turno = await computeReply(from, nome);
      } catch (err) {
        await sendFallback(from, err);
        return;
      }
      // Backstop: o modelo marcou enviarForm mas a análise do anexo deste turno
      // diz que NÃO é comprovante válido (chave de outro destinatário ou não-
      // comprovante) → suprime o handoff por código, independente do prompt.
      const anexoInvalido =
        comprovante && (comprovante.verificacao === 'nao_confere' || comprovante.analise?.ehComprovante === false);
      if (turno.enviarForm && anexoInvalido) {
        console.warn(
          `[comprovante] enviarForm suprimido: anexo inválido (verificacao=${comprovante.verificacao}, ehComprovante=${comprovante.analise?.ehComprovante}).`,
        );
        // Além de suprimir o handoff, TROCA a resposta pelo texto da clínica: no
        // turno do comprovante o prompt v18 manda o modelo não redigir nada ("o
        // que você redigir é descartado"), então o rascunho que sobraria é uma
        // frase trivial (ou o "Desculpa, pode repetir?") — justo quando o
        // paciente precisa saber que o Pix foi pra chave errada.
        const motivo = comprovante.verificacao === 'nao_confere' ? 'nao_confere' : 'nao_comprovante';
        turno = {
          ...turno,
          enviarForm: false,
          resposta: mensagemAnexoInvalido(motivo, process.env.PIX_INFO ?? ''),
        };
      }
      // Entrega em bolhas: se a resposta trouxe parágrafos ou ficou longa, manda
      // 2–3 mensagens seguidas (UX de conversa). Se falhar, lança e não persiste.
      // A decisão do que sai fica AQUI, depois do backstop de comprovante: se ele
      // zerou enviarForm, nenhuma palavra do fechamento oficial é enviada.
      const bolhas = bolhasDoTurno(turno, process.env.FORM_URL ?? '');
      if (turno.enviarForm && !process.env.FORM_URL) {
        console.warn('[webhook] enviarForm=true sem FORM_URL — o fechamento vai sem o link.');
      }
      await sendTextSequence(from, bolhas, { onSent: (id) => registrarEnvios([id]) });
      try {
        // grava o que o paciente REALMENTE recebeu (no handoff, o texto oficial)
        await persistReply(from, nome, { ...turno, resposta: bolhas.join('\n\n') });
      } catch (err) {
        console.error('[webhook] erro ao persistir resposta', err);
      }

      // Handoff: IA sinalizou envio do form → pausa + notifica equipe.
      if (turno.enviarForm) {
        await pauseConversation(from);
        await notifyTeam(from, nome, turno, comprovante);
      }
    } catch (err) {
      console.error('[webhook] erro ao processar mensagem', err);
    }
  });

  return new Response('ok', { status: 200 });
}

/** Linha do comprovante no alerta: valor lido + veredito da chave. */
function linhaComprovante(
  c?: { analise: AnaliseComprovante | null; verificacao: VerificacaoDestinatario },
): string {
  if (!c) return '💰 Comprovante: recebido em turno anterior — conferir na conversa.';
  if (!c.analise) return '💰 Comprovante: ⚠️ SEM validação automática — conferir valor e destinatário manualmente.';
  const v = c.analise.valor != null ? `R$ ${c.analise.valor.toFixed(2).replace('.', ',')}` : 'valor não legível';
  const chave =
    c.verificacao === 'confere'
      ? 'chave confere ✔'
      : c.verificacao === 'nao_confere'
        ? 'CHAVE NÃO CONFERE ⚠️'
        : 'chave não confirmada ⚠️';
  return `💰 Comprovante: ${v} (${chave})`;
}

/**
 * Notificação de trabalho pra Bruna Amorim (psicóloga, quem intervém após o
 * handoff) + dev, via NOTIFY_ALERT_NUMBERS: ficha do paciente + status do
 * comprovante + checklist (pagamento → formulário → PsicoManager).
 */
async function notifyTeam(
  waId: string,
  nome: string | undefined,
  turno: Awaited<ReturnType<typeof computeReply>>,
  comprovante?: { analise: AnaliseComprovante | null; verificacao: VerificacaoDestinatario },
): Promise<void> {
  const recipients = alertRecipients();
  if (recipients.length === 0) {
    console.warn('[webhook] NOTIFY_ALERT_NUMBERS não configurado — sem alerta.');
    return;
  }
  const lead = turno.lead;
  const linhas = [
    '🩵 *Camila (IA) concluiu mais uma triagem automática!*',
    '',
    `👤 Paciente: ${lead.nome || nome || '(sem nome)'}`,
    `📱 WhatsApp: +${waId}`,
    lead.telefone ? `☎️ Telefone informado: ${lead.telefone}` : null,
    lead.email ? `✉️ E-mail: ${lead.email}` : null,
    lead.disponibilidade ? `🗓️ Horário/disponibilidade: ${lead.disponibilidade}` : null,
    lead.preferenciaAbordagem ? `🧠 Preferência: ${lead.preferenciaAbordagem}` : null,
    lead.resumo ? `📝 Queixa: ${lead.resumo}` : lead.motivacao ? `📝 Motivação: ${lead.motivacao}` : null,
    linhaComprovante(comprovante),
    '📋 Formulário de triagem enviado ao paciente.',
    '',
    '*Próximos passos:*',
    '1️⃣ Conferir o pagamento na conta',
    '2️⃣ Confirmar o preenchimento do formulário',
    '3️⃣ Ajustar o horário no PsicoManager',
    '',
    'A IA está pausada nesse número — a conversa agora é de vocês. 💙',
  ].filter(Boolean) as string[];
  const body = linhas.join('\n');
  // o alerta também sai do número da clínica: registra os ids pra que o eco não
  // seja lido como "a equipe assumiu a conversa" com a Bruna ou com o dev.
  const ids = await Promise.all(recipients.map((to) => sendInternalAlert(to, body)));
  await registrarEnvios(ids.filter((id): id is string => Boolean(id)));
}

// O payload cru (Meta ou Z-API) é problema do provider: aqui só circula a
// MensagemRecebida normalizada de `src/lib/wa/types.ts`.
