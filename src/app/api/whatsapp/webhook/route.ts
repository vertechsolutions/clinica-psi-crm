import { after } from 'next/server';
import {
  autenticarWebhook,
  downloadMedia,
  markReadAndType,
  parseWebhook,
  providerNome,
  sendText,
  verifyChallenge,
  type MensagemRecebida,
} from '@/lib/whatsapp';
import {
  foiNossoEnvio,
  isPaused,
  pauseConversation,
  recordAssistantMessage,
  recordUserMessage,
  registrarEnvios,
  temHistorico,
} from '@/lib/conversation';
import { registrarMensagemDoTurno } from '@/lib/turno';
import { transcribeAudio } from '@/lib/transcribe';
import { analisarComprovante } from '@/lib/comprovante';
import {
  chaveEsperada,
  montarMarcadorComprovante,
  verificarDestinatario,
  type AnaliseComprovante,
  type VerificacaoDestinatario,
} from '@/lib/comprovante-core';
import { deveIgnorarPorLegado, ehLegado, marcarLegado } from '@/lib/legado';
import { hasDb } from '@/lib/db';
import { allowlist, atende } from '@/lib/allowlist';
import { semEmoji } from '@/lib/emoji';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Fallback quando a transcrição falha ou o tipo de mídia não é suportado.
 *
 * Sem emoji por decisão da Bruna (06/08/2026) — e o `semEmoji` no call site é a
 * rede, não a origem: sem ele, um dia alguém reintroduz a carinha ao editar o
 * texto e nada avisa.
 */
const PEDE_TEXTO =
  'Oi! Não consegui ouvir seu áudio direito. Pode me mandar por texto o que você precisa? Assim consigo te ajudar melhor.';
const PEDE_TEXTO_OUTRAS_MIDIAS =
  'Oi! Aqui pelo WhatsApp consigo te ajudar melhor por texto. Pode me contar por escrito?';

/** LGPD: log nunca leva o telefone inteiro — só os 4 últimos, pra diagnóstico. */
const mascarar = (waId: string) => `***${waId.slice(-4)}`;

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
 * Eco de mensagem que SAIU do número da clínica (só a Z-API entrega isso). Três
 * origens possíveis:
 * - a própria Camila (id registrado em `wa_outbound` no envio) → ignora, senão a
 *   IA se pausaria sozinha a cada resposta;
 * - a Bruna digitando numa conversa que a Camila já atende → a humana assumiu:
 *   grava no histórico e PAUSA a IA nesse número, pra não existirem duas vozes;
 * - a Bruna falando com QUALQUER outra pessoa pelo mesmo celular (amiga, família,
 *   paciente que ela atende por fora) → **ignora por completo**.
 *
 * Esse terceiro caso é o motivo do `temHistorico`: o número da clínica é o
 * WhatsApp pessoal-profissional dela, e sem essa checagem toda mensagem que ela
 * mandasse pra alguém criaria uma conversa PAUSADA no banco. Efeito: se aquela
 * pessoa procurasse a clínica meses depois, a Camila ficaria muda pra ela e
 * ninguém saberia — o lead sumia em silêncio. De quebra, gravar conversa pessoal
 * de terceiro que nunca pediu triagem é dado que não temos por que guardar.
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
  // Conversa antiga da equipe: nem o que a Bruna digita ali entra no nosso banco.
  // Sem isto, marcar um número como intocável calaria só a entrada.
  if (await ehLegado(msg.waId, msg.lid)) return;
  // conversa que a Camila nunca atendeu não é handoff: é a vida da Bruna
  if (!(await temHistorico(msg.waId))) {
    // ENQUANTO a allowlist estiver preenchida, a IA não fala com ninguém além da
    // equipe — então a Bruna escrevendo pra um número que a Camila nunca atendeu
    // só pode ser conversa dela. Entra na lista (só o hash, nenhum conteúdo), e é
    // assim que os chats que o import não pegou vão sendo cobertos.
    // Depois da virada o mesmo eco significa outra coisa ("a Bruna abordou um lead
    // novo"), e marcá-lo recriaria o bug descrito acima — o lead sumindo em
    // silêncio. Aí volta a ser só ignorar.
    if (allowlist().length > 0) await marcarLegado(msg.waId, 'eco');
    return;
  }
  const texto = msg.texto || `[${msg.tipoCru} enviado pela equipe]`;
  const isNew = await recordAssistantMessage(msg.waId, texto, msg.messageId);
  if (!isNew) return; // reentrega do mesmo eco
  const jaPausada = await isPaused(msg.waId);
  if (!jaPausada) {
    await pauseConversation(msg.waId);
    console.log(`[webhook] atendimento humano detectado em ${mascarar(msg.waId)} — IA pausada nesse número.`);
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

  // A allowlist não se aplica ao eco: nele o `phone` é a CONTRAPARTE da conversa,
  // não a Bruna. Filtrar antes descartava toda mensagem que ela mandasse pra quem
  // não está na lista — justamente o sinal que ensina quem já é paciente dela.
  if (!msg.fromMe && !atende(msg.waId)) {
    // fora da allowlist da estreia: nem grava, nem responde (LGPD — é conversa
    // de terceiro que não pediu triagem). Loga mascarado só pra diagnóstico.
    console.log(`[webhook] número fora da WA_ALLOWLIST (${mascarar(msg.waId)}) — ignorado.`);
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
      // Conversa que já era da Bruna antes da Camila existir nesse número: não é
      // atendimento da IA. Silêncio total.
      //
      // Este é o PRIMEIRO passo de propósito: antes do recordUserMessage (não
      // grava conversa de quem nunca pediu triagem), antes do extractText (áudio
      // de paciente em atendimento humano não vai pro Gemini) e antes do
      // markReadAndType — o badge de não-lida no celular da Bruna é a rede de
      // segurança inteira, e marcar como lida aqui a destruiria em silêncio.
      // O teste `test-webhook-http` assegura ZERO linha em wa_messages neste
      // caminho; é o que impede um refactor futuro de coletar antes de calar.
      const silencio = await deveIgnorarPorLegado(from, msg.lid);
      if (silencio) {
        // o motivo distingue operação normal ("legado") de "a IA está calada com
        // TODO MUNDO" — que é o que a vigília depois da virada precisa enxergar
        console.log(`[webhook] IA silenciosa em ${mascarar(from)} — motivo: ${silencio}.`);
        return;
      }

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
        const id = await sendText(from, semEmoji(fallback));
        if (id) await registrarEnvios([id]);
        return;
      }

      const isNew = await recordUserMessage(from, texto, wamid);
      if (!isNew) return; // reentrega do provider: já processada

      if (paused) {
        // grava a mensagem entrante mas NÃO responde — silêncio da IA é o
        // combinado. Loga pra Bruna ver que teve resposta do paciente.
        console.log(`[webhook] conversa ${mascarar(from)} pausada — mensagem gravada, IA silenciosa.`);
        return;
      }

      // Fica POR MENSAGEM de propósito. Na Z-API isto só marca lida (o
      // "digitando" viaja no `delayTyping` do envio) e na Meta o indicador expira
      // em 25s — chamar de novo apenas o renova. Segurar até o fim da janela
      // deixaria o paciente vendo a mensagem como não-lida por 8s, que é o
      // oposto do que o debounce existe para melhorar.
      await markReadAndType(msg);

      // Daqui em diante a responsabilidade é do TURNO, não da mensagem. Este
      // `await` é o que mantém a request viva: a doc do Next (16.2.7,
      // `functions/after.md`) garante a sobrevivência pela promise do callback
      // (`waitUntil`), não por um `setTimeout` solto dentro dele. A agenda só
      // resolve esta promise quando o turno terminou ou quando uma request mais
      // nova assumiu o buffer deste número — trocar por fire-and-forget faria o
      // Next descartar a resposta do paciente no meio.
      //
      // O print de 06/08/2026 morre aqui: três mensagens seguidas viram uma
      // janela só, e o claim do Postgres cobre o que a memória de um processo
      // não vê.
      await registrarMensagemDoTurno({ waId: from, nome, comprovante });
    } catch (err) {
      console.error('[webhook] erro ao processar mensagem', err);
    }
  });

  return new Response('ok', { status: 200 });
}

// O payload cru (Meta ou Z-API) é problema do provider: aqui só circula a
// MensagemRecebida normalizada de `src/lib/wa/types.ts`.
