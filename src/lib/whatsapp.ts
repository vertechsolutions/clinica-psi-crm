/**
 * Fachada de mensageria: o resto do app fala com este módulo e não sabe qual
 * transporte está atrás. A escolha é a env `WA_PROVIDER`:
 *
 *   zapi (default) — Z-API, número pareado por QR code no celular da Bruna
 *   meta           — WhatsApp Cloud API (Graph API), o transporte do piloto
 *
 * Voltar atrás é trocar a variável e reiniciar; o código dos dois vive lado a
 * lado em `src/lib/wa/`.
 */
import { metaProvider } from './wa/meta';
import { zapiProvider } from './wa/zapi';
import type { MensagemRecebida, Midia, MidiaRef, RequisicaoWebhook, WaProvider } from './wa/types';

export type { MensagemRecebida, Midia, MidiaRef, RequisicaoWebhook };
export { normalizarWaId } from './wa/types';

function escolher(): WaProvider {
  const escolhido = (process.env.WA_PROVIDER || 'zapi').trim().toLowerCase();
  if (escolhido === 'meta') return metaProvider;
  if (escolhido !== 'zapi') {
    console.warn(`[whatsapp] WA_PROVIDER="${escolhido}" desconhecido — usando zapi.`);
  }
  return zapiProvider;
}

const provider = escolher();

/** Qual transporte está no ar (aparece no boot e no health). */
export const providerNome = provider.nome;
/** true quando dá pra enviar mensagem (credenciais presentes). */
export const canSend = provider.canSend;
/** Meta exige template fora da janela de 24h; Z-API não tem janela. */
export const precisaTemplate = provider.precisaTemplate;

/** Handshake por GET (só a Meta usa). null = recusar com 403. */
export function verifyChallenge(url: URL): string | null {
  return provider.verifyChallenge(url);
}

/** Autentica a chamada do webhook. Fail-closed em ambos os providers. */
export function autenticarWebhook(raw: string, req: RequisicaoWebhook): boolean {
  return provider.autenticar(raw, req);
}

/** Payload cru → mensagens normalizadas (vazio = evento que não interessa). */
export function parseWebhook(raw: string): MensagemRecebida[] {
  return provider.parse(raw);
}

/** Envia uma mensagem de texto. Devolve o id (usado pra reconhecer o eco). */
export function sendText(to: string, body: string): Promise<string | null> {
  return provider.sendText(to, body);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Envia várias mensagens em sequência (bolhas separadas), com um respiro entre
 * elas pra parecer uma pessoa digitando. Usado com splitReply(). Se uma parte
 * falha, propaga (o webhook loga e não persiste) — parte já enviada fica no chat.
 * Devolve os ids enviados: o webhook os registra pra não confundir o eco da
 * própria Camila com a Bruna assumindo a conversa no celular.
 */
export async function sendTextSequence(
  to: string,
  parts: string[],
  opts: { delayMs?: number; onSent?: (id: string) => Promise<void> | void } = {},
): Promise<string[]> {
  const { delayMs = 900, onSent } = opts;
  const ids: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]?.trim();
    if (!p) continue;
    const id = await sendText(to, p);
    if (id) {
      ids.push(id);
      // registra JÁ (não no fim do laço): o eco desta bolha pode chegar enquanto
      // as próximas ainda estão sendo enviadas.
      if (onSent) await onSent(id);
    }
    if (i < parts.length - 1) await sleep(delayMs);
  }
  return ids;
}

/** Marca lida + "digitando". Best-effort: nunca lança. */
export function markReadAndType(msg: { waId: string; messageId: string }): Promise<void> {
  return provider.markReadAndType(msg);
}

/** Baixa a mídia referenciada na mensagem. null em falha (best-effort). */
export function downloadMedia(ref: MidiaRef): Promise<Midia | null> {
  return provider.downloadMedia(ref);
}

/** Template aprovado — só faz sentido no provider Meta (fora da janela de 24h). */
export function sendTemplate(to: string, name: string, lang?: string): Promise<string | null> {
  return provider.sendTemplate(to, name, lang);
}

/**
 * Envia uma notificação interna pra equipe (Bruna, atendentes, dev) sem quebrar
 * o fluxo do paciente. Falha silenciosa: se der ruim, apenas loga.
 * `to` deve ser E.164 sem "+" (ex.: "5527981178233").
 */
export async function sendInternalAlert(to: string, body: string): Promise<string | null> {
  try {
    return await sendText(to, body);
  } catch (err) {
    // número mascarado como em todo o resto (era o único log com telefone inteiro)
    console.error(`[whatsapp] alerta interno pra ***${to.slice(-4)} falhou`, err);
    return null;
  }
}
