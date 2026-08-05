/**
 * Contrato de transporte do WhatsApp. Existe pra que o miolo (conversa, triagem,
 * comprovante, fechamento) não saiba QUEM entrega a mensagem: hoje a Z-API
 * (não-oficial, conecta por QR code no celular da Bruna), antes a Cloud API da
 * Meta. A escolha é a env `WA_PROVIDER` — trocar de volta é uma variável, não um
 * deploy de código.
 *
 * Cada provider resolve 5 coisas: autenticar o webhook, normalizar o payload
 * recebido, enviar texto, marcar lida/digitando e baixar mídia.
 */

export type Provider = 'meta' | 'zapi';

/**
 * Como chegar nos bytes da mídia. A Meta dá um `id` (dois hops: resolve URL
 * assinada, depois baixa); a Z-API já entrega a `url` direta.
 */
export interface MidiaRef {
  id?: string;
  url?: string;
  mimeType?: string;
}

export type TipoMensagem = 'text' | 'audio' | 'image' | 'document' | 'outro';

/** Mensagem recebida, normalizada — é isto que o webhook enxerga. */
export interface MensagemRecebida {
  /** só dígitos, E.164 sem "+" (ex.: "5527988420050") — é a PK das conversas */
  waId: string;
  /** id estável da mensagem: dedup por `wa_messages.wamid` depende dele */
  messageId: string;
  tipo: TipoMensagem;
  texto?: string;
  legenda?: string;
  midia?: MidiaRef;
  /** nome do perfil do WhatsApp (pushName), quando o provider manda */
  nome?: string;
  /**
   * Identificador anônimo (`@lid`) que a Z-API entrega no lugar do telefone quando
   * o contato liga a privacidade de número. Quando ele aparece, o `waId` NÃO é um
   * telefone — e nenhuma lista construída a partir de telefone (a de legado, a
   * allowlist) consegue reconhecer essa pessoa. Fica registrado pra que isso seja
   * visível em vez de silencioso.
   */
  lid?: string;
  /**
   * true = a mensagem SAIU do número da clínica. Pode ser a Camila (nosso envio
   * pela API, que volta como eco) ou a Bruna digitando no celular — quem separa
   * os dois é o webhook, consultando os ids que registramos ao enviar.
   */
  fromMe: boolean;
  isGroup: boolean;
  /** rótulo cru do tipo, pro histórico quando não tratamos a mídia (ex.: "sticker") */
  tipoCru: string;
}

/** Bytes de uma mídia já baixada — contrato que transcribe/comprovante consomem. */
export interface Midia {
  bytes: Buffer;
  mimeType: string;
}

export interface RequisicaoWebhook {
  headers: Headers;
  url: URL;
}

export interface WaProvider {
  readonly nome: Provider;
  /** dá pra enviar mensagem? (credenciais presentes) */
  readonly canSend: boolean;
  /**
   * O provider exige template aprovado pra falar fora da janela de 24h?
   * Meta sim; Z-API não (é o WhatsApp da Bruna pareado, sem janela).
   */
  readonly precisaTemplate: boolean;

  /**
   * Handshake de verificação por GET (a Meta chama ao configurar o Callback URL).
   * Retorna o corpo a devolver, ou null quando não bate / o provider não usa.
   */
  verifyChallenge(url: URL): string | null;

  /**
   * Autentica a chamada do webhook. FAIL-CLOSED: sem segredo configurado,
   * recusa tudo — um webhook aberto deixa qualquer um injetar mensagem falsa.
   */
  autenticar(raw: string, req: RequisicaoWebhook): boolean;

  /** Extrai as mensagens do payload cru. Ignora status/entrega/eventos. */
  parse(raw: string): MensagemRecebida[];

  /** Envia texto. Devolve o id da mensagem enviada (pra reconhecer o eco). */
  sendText(to: string, body: string): Promise<string | null>;

  /** Best-effort: marca lida e mostra "digitando". Nunca lança. */
  markReadAndType(msg: { waId: string; messageId: string }): Promise<void>;

  downloadMedia(ref: MidiaRef): Promise<Midia | null>;

  /** Só faz sentido quando `precisaTemplate` — reengajamento fora da janela. */
  sendTemplate(to: string, name: string, lang?: string): Promise<string | null>;
}

/** Tira "+", espaços e sufixos tipo "@c.us": o wa_id é só dígitos. */
export function normalizarWaId(bruto: string): string {
  return (bruto || '').replace(/\D/g, '');
}

/** Sufixos de identificador que NÃO são uma pessoa: grupo, lista de transmissão,
 *  status e canal. `replace(/\D/g,'')` os transformaria em dígitos inocentes. */
const NAO_E_PESSOA = /-group|@g\.us|@broadcast|@newsletter|status@/i;

/**
 * O identificador é de uma conversa individual com uma pessoa?
 *
 * Existe porque `normalizarWaId('status@broadcast')` é a string VAZIA, e uma
 * conversa de wa_id vazio junta as atualizações de status de todo mundo numa
 * "paciente" só. Um E.164 sem "+" tem de 10 (fixo curto no exterior) a 15 dígitos
 * — fora dessa faixa não é telefone de gente.
 */
export function ehConversaIndividual(phoneCru: string | undefined, isNewsletter = false): boolean {
  if (isNewsletter) return false;
  if (!phoneCru || NAO_E_PESSOA.test(phoneCru)) return false;
  const digitos = normalizarWaId(phoneCru);
  return digitos.length >= 10 && digitos.length <= 15;
}
