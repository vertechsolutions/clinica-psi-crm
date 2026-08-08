/**
 * O ciclo de I/O do turno: o que acontece quando a janela de debounce fecha.
 *
 * A metade PURA — buffer por `wa_id`, timer cancelável, teto anti-starvation e
 * orçamento de retry — vive em `turno-agenda.ts` e é testada sem infraestrutura
 * nenhuma. Este arquivo é o outro lado: monta a agenda com as dependências
 * reais (relógio, `setTimeout`, env) e implementa o `executar` — claim →
 * resposta → envio → persistência → desfecho.
 *
 * Absorve do `route.ts` tudo o que era DESFECHO do turno e não roteação HTTP: o
 * backstop de comprovante, o alerta de equipe e o aviso de instabilidade. O
 * `route` fica com o que é dele — assinatura, allowlist, legado, pausa,
 * `extractText`, dedup por wamid e `markReadAndType`, que continuam POR
 * MENSAGEM.
 */
import { computeReply, loadHistory, pauseConversation, persistReply, registrarEnvios } from './conversation';
import { bolhasDoTurno } from './fechamento';
import { sendInternalAlert, sendText, sendTextSequence } from './whatsapp';
import { pareceBot, ultimosTurnosDoLead } from './anti-bot';
import { mensagemAnexoInvalido } from './comprovante-core';
import { semEmoji } from './emoji';
import { aindaTitular, claimTurno, releaseTurno } from './turno-claim';
import type { MensagemHistorico } from './retomada';
import {
  criarAgenda,
  escolherComprovante,
  type Acumulado,
  type Agenda,
  type ComprovanteDoTurno,
  type EntradaDeTurno,
  type ResultadoExecucao,
} from './turno-agenda';

/** LGPD: log nunca leva o telefone inteiro — só os 4 últimos, pra diagnóstico. */
const mascarar = (waId: string) => `***${waId.slice(-4)}`;

/** Silêncio que fecha a janela. 8s foi o combinado com a Bruna em 06/08/2026. */
const DEBOUNCE_PADRAO_MS = 8_000;

/**
 * Lido a CADA chamada, nunca cacheado em `const` de módulo: o teste de
 * concorrência sobe o app num processo filho com `DEBOUNCE_MS=500` pra não pagar
 * 8s por cenário, e um valor congelado no import ignoraria isso.
 *
 * Valor inválido ou ausente cai no default em vez de virar `NaN` — um `NaN` aqui
 * viraria `setTimeout(fn, NaN)`, que o Node trata como 1ms: o debounce sumiria
 * em silêncio e o bug da print voltaria sem ninguém perceber.
 */
export function debounceMs(): number {
  const bruto = process.env.DEBOUNCE_MS?.trim();
  if (!bruto) return DEBOUNCE_PADRAO_MS;
  const n = Number(bruto);
  return Number.isFinite(n) && n >= 0 ? n : DEBOUNCE_PADRAO_MS;
}

/**
 * Uma agenda por PROCESSO, guardada em `globalThis` pelo mesmo motivo do pool do
 * `db.ts`: o hot-reload do `next dev` troca o módulo, e um `let` de topo de
 * arquivo viraria uma SEGUNDA agenda com um segundo buffer para os mesmos
 * `wa_id` — dois turnos paralelos para o mesmo número, que é exatamente o bug
 * que esta leva existe para matar. Em produção o cache de módulo já garante o
 * singleton. O claim do Postgres ainda seguraria a duplicata, mas ele é a última
 * rede, não a primeira.
 *
 * Lazy como o pool: nada de I/O nem leitura de env no import.
 */
const g = globalThis as unknown as { __clinicaAgendaTurno?: Agenda };

function agenda(): Agenda {
  if (!g.__clinicaAgendaTurno) {
    g.__clinicaAgendaTurno = criarAgenda({
      executar,
      // `setTimeout` SEM `unref()`: um turno agendado precisa segurar o processo
      // vivo. Com unref, o Node sairia com a resposta do paciente pendente.
      agendar: (fn, ms) => setTimeout(fn, ms),
      cancelar: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      agora: () => Date.now(),
      debounceMs,
    });
  }
  return g.__clinicaAgendaTurno;
}

/**
 * Porta de entrada do webhook. Acumula a mensagem na janela do `wa_id` e devolve
 * a promise que o `after()` precisa AGUARDAR.
 *
 * Esse await é o que mantém a request viva até o turno rodar: a doc do Next
 * (16.2.7, `functions/after.md`) diz que o que estende a invocação é a promise
 * do callback, via `waitUntil`. Um `setTimeout` solto dentro do `after()` não
 * tem sobrevivência garantida — quem segura o titular é a agenda.
 *
 * Nunca lança (a agenda trata o próprio erro): derrubar aqui mataria o `after()`
 * inteiro, e com ele o resto do processamento da mensagem.
 */
export function registrarMensagemDoTurno(e: EntradaDeTurno): Promise<void> {
  return agenda().registrar(e);
}

/**
 * Porta de entrada da varredura de boot. Roda o ciclo DIRETO, sem passar pelo
 * buffer: no boot não há rajada a esperar — a mensagem já é antiga e o objetivo
 * é responder, não juntar mais nada.
 *
 * É a ÚNICA porta que NÃO reagenda quando o claim falha. Perder o claim aqui
 * significa que outro turno está com o número (o webhook vivo, ou o processo
 * anterior cujo claim ainda não expirou), e insistir seria a varredura
 * competindo com um atendimento em andamento. No webhook a conta é a oposta:
 * lá, desistir perderia a mensagem para sempre.
 *
 * Nunca lança — um número problemático não pode interromper a varredura dos
 * outros.
 */
export async function processarTurnoPendente(waId: string, nome?: string): Promise<void> {
  try {
    // Sem comprovante: neste caminho não há análise de anexo fresca. Limitação
    // aceita no desenho — o alerta de equipe cobre com "recebido em turno
    // anterior, conferir na conversa".
    const pegou = await rodarSobClaim(waId, nome, undefined);
    if (!pegou) {
      console.log(`[turno] varredura: ${mascarar(waId)} já tem turno em andamento — deixando com ele.`);
    }
  } catch (err) {
    console.error(`[turno] varredura falhou em ${mascarar(waId)}`, err);
  }
}

/** SIGTERM: cancela as janelas ainda não disparadas e solta os titulares. */
export function cancelarJanelas(): number {
  return agenda().cancelarJanelas();
}

/**
 * O que a agenda chama quando a janela fecha.
 *
 * Devolve `claim-perdido` SÓ quando outro turno deste mesmo número está com a
 * vez — é o único desfecho que a agenda trata de forma especial, reagendando em
 * vez de descartar a mensagem. Qualquer outra coisa é `ok`, inclusive erro: o
 * que falhou já foi logado, e insistir contra um Gemini ou um banco fora do ar
 * só prenderia a promise do `after()` por mais dois minutos, atrasando o
 * shutdown sem salvar ninguém. A rede que sobra é a varredura de boot.
 */
async function executar(a: Acumulado): Promise<ResultadoExecucao> {
  try {
    const pegou = await rodarSobClaim(a.waId, a.nome, escolherComprovante(a.comprovantes));
    return pegou ? 'ok' : 'claim-perdido';
  } catch (err) {
    console.error(`[turno] ciclo de ${mascarar(a.waId)} falhou`, err);
    return 'ok';
  }
}

/**
 * Roda o desfecho sob o claim. `false` quer dizer "a vez é de outro turno" —
 * quem chama decide se reagenda (webhook) ou desiste (varredura de boot).
 */
async function rodarSobClaim(
  waId: string,
  nome: string | undefined,
  comprovante: ComprovanteDoTurno | undefined,
): Promise<boolean> {
  const token = await claimTurno(waId);
  if (token === null) return false;
  try {
    await desfechoDoTurno(waId, token, nome, comprovante);
  } finally {
    // Libera em TODO caminho de saída, inclusive no de erro: sem isto o número
    // ficaria mudo até o TTL de 90s expirar.
    await releaseTurno(waId, token);
    // E avisa a agenda na hora. Quem perdeu o claim está numa escada de backoff
    // de até 8s; sem este empurrão, o lead esperaria o degrau inteiro depois de
    // a vaga já estar livre.
    agenda().acordar(waId);
  }
  return true;
}

/**
 * A sequência do turno, já com a vez garantida: descarta o turno se do outro
 * lado houver um robô, gera a resposta, aplica o backstop de comprovante,
 * reconfere a titularidade, envia, persiste o que o paciente REALMENTE recebeu
 * e, no handoff, pausa e chama a equipe.
 */
async function desfechoDoTurno(
  waId: string,
  token: string,
  nome: string | undefined,
  comprovante: ComprovanteDoTurno | undefined,
): Promise<void> {
  // Anti-bot ANTES do `computeReply`: um turno que vai terminar em silêncio não
  // pode custar duas chamadas ao Gemini — decidir depois seria pagar justamente
  // pelo loop que esta defesa existe para cortar.
  //
  // Sair por aqui é `return` seco: quem chama (`rodarSobClaim`) libera o claim e
  // acorda a agenda no `finally`, então este caminho não deixa o número preso.
  const historico = await historicoParaAntiBot(waId);
  if (historico && pareceBot(historico)) {
    console.warn(`[anti-bot] ${mascarar(waId)}: 3 turnos idênticos do lead — conversa pausada, sem resposta.`);
    await pauseConversation(waId);
    await alertarSuspeitaDeBot(waId, nome, ultimosTurnosDoLead(historico));
    return;
  }

  let turno: Awaited<ReturnType<typeof computeReply>>;
  try {
    turno = await computeReply(waId, nome);
  } catch (err) {
    // O aviso de instabilidade também é uma bolha no WhatsApp do paciente: se
    // outro turno assumiu o número enquanto a geração falhava, mandá-lo aqui
    // seria a segunda mensagem que esta leva existe para impedir.
    if (await aindaTitular(waId, token)) {
      await sendFallback(waId, err);
    } else {
      console.error('[turno] erro ao gerar resposta (aviso suprimido: titularidade perdida)', err);
    }
    return;
  }

  // Backstop: o modelo marcou enviarForm mas a análise do anexo deste turno diz
  // que NÃO é comprovante válido (chave de outro destinatário ou não-comprovante)
  // → suprime o handoff por código, independente do prompt.
  //
  // Com o debounce, "o anexo deste turno" é o que o `escolherComprovante`
  // escolheu na rajada inteira: qualquer anexo aceitável da janela vence, para
  // que a selfie mandada depois do comprovante certo não vire acusação.
  const anexoInvalido =
    comprovante && (comprovante.verificacao === 'nao_confere' || comprovante.analise?.ehComprovante === false);
  if (turno.enviarForm && anexoInvalido) {
    console.warn(
      `[comprovante] enviarForm suprimido: anexo inválido (verificacao=${comprovante.verificacao}, ehComprovante=${comprovante.analise?.ehComprovante}).`,
    );
    // Além de suprimir o handoff, TROCA a resposta pelo texto da clínica: no
    // turno do comprovante o prompt v18 manda o modelo não redigir nada ("o que
    // você redigir é descartado"), então o rascunho que sobraria é uma frase
    // trivial (ou o "Desculpa, pode repetir?") — justo quando o paciente precisa
    // saber que o Pix foi pra chave errada.
    const motivo = comprovante.verificacao === 'nao_confere' ? 'nao_confere' : 'nao_comprovante';
    turno = {
      ...turno,
      enviarForm: false,
      resposta: mensagemAnexoInvalido(motivo, process.env.PIX_INFO ?? ''),
    };
  }

  // Entrega em bolhas: se a resposta trouxe parágrafos ou ficou longa, manda
  // 2–3 mensagens seguidas (UX de conversa). A decisão do que sai fica AQUI,
  // depois do backstop: se ele zerou enviarForm, nenhuma palavra do fechamento
  // oficial é enviada.
  const bolhas = bolhasDoTurno(turno, process.env.FORM_URL ?? '');
  if (turno.enviarForm && !process.env.FORM_URL) {
    console.warn('[turno] enviarForm=true sem FORM_URL — o fechamento vai sem o link.');
  }

  // A última pergunta antes do primeiro byte que sai para o paciente. O turno
  // demora dezenas de segundos (duas chamadas ao Gemini); se o TTL estourou e
  // outro turno assumiu nesse meio-tempo, abortar em silêncio é melhor do que
  // entregar o mesmo par de bolhas duas vezes — o print de 06/08/2026.
  if (!(await aindaTitular(waId, token))) {
    console.warn(`[turno] titularidade de ${mascarar(waId)} perdida durante a geração — envio abortado.`);
    return;
  }

  await sendTextSequence(waId, bolhas, { onSent: (id) => registrarEnvios([id]) });
  try {
    // grava o que o paciente REALMENTE recebeu (no handoff, o texto oficial, já
    // sem emoji — o filtro roda dentro do `bolhasDoTurno`)
    await persistReply(waId, nome, { ...turno, resposta: bolhas.join('\n\n') });
  } catch (err) {
    console.error('[turno] erro ao persistir resposta', err);
  }

  // Handoff: IA sinalizou envio do form → pausa + notifica equipe.
  if (turno.enviarForm) {
    await pauseConversation(waId);
    await notifyTeam(waId, nome, turno, comprovante);
  }
}

/**
 * O histórico do número, lido para o anti-bot e só para ele — é o único
 * consumidor de histórico deste arquivo, já que o `computeReply` carrega o dele
 * por dentro. Sim, no caminho em que o anti-bot não dispara o histórico é lido
 * duas vezes; é um SELECT de 30 linhas contra uma chamada ao Gemini, e é o preço
 * de decidir ANTES de gastar o modelo.
 *
 * `null` em falha, e o turno segue NORMALMENTE. Um SELECT que caiu não é prova
 * de robô nenhum, e tratar dúvida como suspeita calaria um paciente por causa de
 * uma indisponibilidade do banco — a direção segura do erro está declarada no
 * `anti-bot.ts`: deixar um bot conversar custa token, calar um paciente custa o
 * paciente. É a assimetria OPOSTA à do `aindaTitular`, que falha fechado de
 * propósito: lá o risco de errar é mandar a mesma bolha duas vezes, aqui é
 * emudecer com quem está pedindo ajuda.
 */
async function historicoParaAntiBot(waId: string): Promise<MensagemHistorico[] | null> {
  try {
    return await loadHistory(waId);
  } catch (err) {
    console.error(`[anti-bot] histórico de ${mascarar(waId)} não carregou — seguindo o turno sem julgar`, err);
    return null;
  }
}

/**
 * Aviso quando a geração da resposta falha.
 *
 * Sem emoji por decisão da Bruna (06/08/2026) — e o `semEmoji` no call site é a
 * rede, não a origem: sem ele, um dia alguém reintroduz a carinha ao editar o
 * texto e nada avisa.
 */
const FALHA_TEMPORARIA =
  'Tive uma instabilidade aqui agora. Pode me mandar a mensagem de novo em alguns segundos?';

/** Envia o aviso de instabilidade quando a geração da resposta falha (best-effort). */
async function sendFallback(to: string, err: unknown): Promise<void> {
  console.error('[turno] erro ao gerar resposta', err);
  try {
    await sendText(to, semEmoji(FALHA_TEMPORARIA));
  } catch (fallbackErr) {
    console.error('[turno] erro ao enviar fallback', fallbackErr);
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

/** Linha do comprovante no alerta: valor lido + veredito da chave. */
function linhaComprovante(c?: ComprovanteDoTurno): string {
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
 *
 * Alerta INTERNO: os emojis ficam. A regra "sem emoji" é do que chega ao
 * paciente, e aqui eles são o que faz a equipe achar a linha certa no celular.
 */
async function notifyTeam(
  waId: string,
  nome: string | undefined,
  turno: Awaited<ReturnType<typeof computeReply>>,
  comprovante?: ComprovanteDoTurno,
): Promise<void> {
  const recipients = alertRecipients();
  if (recipients.length === 0) {
    console.warn('[turno] NOTIFY_ALERT_NUMBERS não configurado — sem alerta.');
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

/**
 * Teto do trecho citado no alerta. Um turno lógico é a rajada inteira
 * concatenada, então o texto que o robô repetiu não tem tamanho máximo — e um
 * alerta que estoure o limite do WhatsApp não é entregue, deixando a equipe sem
 * saber do chat que a Camila acabou de calar. Justamente o silêncio que este
 * alerta existe para impedir.
 */
const MAX_TRECHO_ALERTA = 300;

/** Uma linha só, legível no celular: colapsa as quebras da rajada e corta o excesso. */
function trechoDoTurno(texto: string): string {
  const limpo = texto.trim().replace(/\s+/g, ' ');
  return limpo.length > MAX_TRECHO_ALERTA ? `${limpo.slice(0, MAX_TRECHO_ALERTA)}…` : limpo;
}

/**
 * Alerta de suspeita de bot: a Camila parou de responder este número e a equipe
 * precisa saber AGORA — se do outro lado houver gente, o lead está em silêncio
 * até alguém reativar (pedida da Bruna, 06/08/2026).
 *
 * Traz os quatro elementos que a equipe julga pelo celular: o número, o motivo,
 * as mensagens repetidas na íntegra do que couber, e o que fazer se for engano.
 *
 * Alerta INTERNO: os emojis ficam, como no `notifyTeam`. A regra "sem emoji" é
 * do que chega ao PACIENTE; aqui eles são o marcador de campo que faz a Bruna
 * achar a linha certa de relance.
 */
async function alertarSuspeitaDeBot(waId: string, nome: string | undefined, turnos: string[]): Promise<void> {
  const recipients = alertRecipients();
  if (recipients.length === 0) {
    // A pausa já aconteceu — o loop está cortado de qualquer jeito. O que se
    // perde aqui é o aviso, e é por isso que isto é um warn e não um debug.
    console.warn('[anti-bot] NOTIFY_ALERT_NUMBERS não configurado — chat pausado sem avisar ninguém.');
    return;
  }
  const linhas = [
    '🤖 *Camila pausou um chat por suspeita de bot.*',
    '',
    `📱 WhatsApp: +${waId}`,
    nome ? `👤 Contato: ${nome}` : null,
    '🔁 Motivo: os 3 últimos turnos desse número chegaram com o mesmo texto. Do outro lado parece ter um robô, e continuar respondendo viraria loop.',
    '',
    '*As mensagens repetidas:*',
    ...turnos.map((t) => `💬 ${trechoDoTurno(t)}`),
    '',
    'A IA está pausada nesse número — não sai mais nada automático por aqui.',
    'Se for engano e tiver gente do outro lado, é só devolver a conversa pra IA no painel que a Camila volta a responder. 💙',
  ].filter(Boolean) as string[];
  const body = linhas.join('\n');
  // mesmo motivo do `notifyTeam`: o alerta sai do número da clínica, e sem
  // registrar o id o eco dele voltaria pelo webhook como "a equipe assumiu a
  // conversa" — pausando o chat da Bruna ou do dev.
  const ids = await Promise.all(recipients.map((to) => sendInternalAlert(to, body)));
  await registrarEnvios(ids.filter((id): id is string => Boolean(id)));
}
