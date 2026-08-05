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
  ehConversaIndividual,
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

/** Cabeçalhos comuns. Client-Token é a trava da conta: com ela ligada no painel,
 *  toda requisição sem o header é recusada. */
function headersZapi(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (CLIENT_TOKEN) headers['Client-Token'] = CLIENT_TOKEN;
  return headers;
}

/**
 * Mensagem de erro segura. NUNCA inclui a URL: o `ZAPI_INSTANCE_TOKEN` vive dentro
 * do path (ver BASE) e é credencial de portador — quem o tem envia WhatsApp como a
 * clínica. Num log do Railway ele é pior que qualquer telefone. Também não leva o
 * corpo cru, que tem telefone de paciente.
 */
function erroZapi(path: string, status: number, j: { error?: string; message?: string }): Error {
  return new Error(`Z-API ${path} ${status} ${j?.error || j?.message || ''}`.trim());
}

/**
 * Texto seguro de um erro qualquer, pra log. Nunca o objeto cru: num erro de rede
 * a `cause` da undici carrega a URL da requisição, e o token está DENTRO dela.
 */
export function mensagemDeErro(err: unknown): string {
  let texto = (err instanceof Error ? err.message : String(err)).slice(0, 300);
  // cinto e suspensórios: se mesmo assim vier um segredo no texto, some com ele
  for (const segredo of [TOKEN, INSTANCE, CLIENT_TOKEN]) {
    if (segredo) texto = texto.split(segredo).join('***');
  }
  return texto;
}

async function zapiPost(path: string, body: unknown): Promise<Record<string, unknown> | null> {
  if (!canSend) {
    console.warn('[zapi] envio ignorado — ZAPI_INSTANCE_ID/ZAPI_INSTANCE_TOKEN ausentes.');
    return null;
  }
  const res = await fetch(`${BASE}/${path}`, {
    method: 'POST',
    headers: headersZapi(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // nunca loga o corpo cru (tem telefone do paciente) — só status e o campo error
    const j = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new Error(`Z-API ${path} ${res.status} ${j?.error || j?.message || ''}`.trim());
  }
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

/**
 * Gêmeo do `zapiPost` pro lado de LEITURA (status da instância, lista de chats).
 * Fica fora do contrato `WaProvider` de propósito: `types.ts` descreve transporte
 * de mensagem, e isto é consulta ao aparelho — coisa que só a Z-API oferece.
 */
async function zapiGet(path: string, params?: Record<string, string | number>): Promise<unknown> {
  if (!canSend) {
    console.warn('[zapi] consulta ignorada — ZAPI_INSTANCE_ID/ZAPI_INSTANCE_TOKEN ausentes.');
    return null;
  }
  const qs = params
    ? `?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString()}`
    : '';
  const res = await fetch(`${BASE}/${path}${qs}`, { method: 'GET', headers: headersZapi() });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw erroZapi(path, res.status, j);
  }
  return await res.json().catch(() => null);
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
  isNewsletter?: boolean;
  /** identificador anônimo do contato quando ele liga a privacidade de número */
  chatLid?: string;
  senderLid?: string;
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
  poll?: unknown;
  reaction?: unknown;
  buttonsResponseMessage?: unknown;
  listResponseMessage?: unknown;
  // recibo de entrega (DeliveryCallback) chega com estes — e sem conteúdo
  zaapId?: string;
  status?: string;
  ids?: string[];
}

/**
 * Blocos de conteúdo que a Z-API manda numa mensagem de verdade. A lista existe
 * pra separar mensagem de CALLBACK: o "DeliveryCallback" (recibo de entrega)
 * também vem com `phone` e `messageId`, e sem este filtro entraria no histórico
 * como se fosse fala do paciente — a Camila responderia "me manda por texto" a
 * cada recibo do que ela mesma enviou.
 */
const BLOCOS_DE_CONTEUDO = [
  'text',
  'image',
  'audio',
  'document',
  'video',
  'sticker',
  'contact',
  'location',
  'poll',
  'reaction',
  'buttonsResponseMessage',
  'listResponseMessage',
] as const;

/** Rótulo cru do tipo, pro histórico ("[sticker]") quando não tratamos a mídia. */
function tipoCruDe(p: ZapiWebhook): string {
  for (const k of BLOCOS_DE_CONTEUDO) {
    if (p[k as keyof ZapiWebhook]) return k;
  }
  return p.type || 'desconhecido';
}

/** Só é mensagem se trouxe conteúdo (ou se a própria Z-API rotulou como recebida). */
function ehMensagem(p: ZapiWebhook): boolean {
  if (BLOCOS_DE_CONTEUDO.some((k) => p[k as keyof ZapiWebhook])) return true;
  return p.type === 'ReceivedCallback';
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
    // eventos de conexão/status não têm par phone+messageId...
    if (!p.phone || !p.messageId) return [];
    // ...e o recibo de entrega tem, mas não é fala de ninguém
    if (!ehMensagem(p)) return [];
    // grupo não é atendimento: a clínica não conversa com paciente em grupo
    if (p.isGroup) return [];
    // instância errada = chamada que não é da nossa conta
    if (INSTANCE && p.instanceId && p.instanceId !== INSTANCE) {
      console.warn('[zapi] evento de outra instância ignorado.');
      return [];
    }
    // Status/broadcast, canal e grupo cujo `isGroup` não veio. Enquanto a
    // WA_ALLOWLIST está preenchida isto fica escondido (`atende('')` é false só
    // porque a lista tem números); esvaziá-la abriria caminho pra status@broadcast
    // virar uma "conversa" de wa_id vazio, chamando o Gemini e tentando enviar
    // resposta pra telefone nenhum.
    if (!ehConversaIndividual(p.phone, p.isNewsletter === true)) return [];

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
      // só quando o `phone` VEIO como @lid — aí o waId acima não é telefone
      lid: /@lid/i.test(p.phone) ? p.chatLid || p.senderLid || p.phone : undefined,
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
      // só a mensagem, nunca o erro cru: numa falha de rede a `cause` da undici
      // carrega a URL — e o ZAPI_INSTANCE_TOKEN vive dentro do path (ver BASE).
      console.error('[zapi] read-message falhou:', mensagemDeErro(err));
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
      console.error('[zapi] downloadMedia falhou:', mensagemDeErro(err));
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

// ─────────────────────────── consultas ao aparelho ───────────────────────────
// Só a Z-API tem isto (a Cloud API não expõe o que está no celular). Serve pra
// dois usos: diagnosticar a instância e semear a lista de conversas que já eram
// atendidas à mão pela Bruna antes da IA entrar (ver src/lib/legado.ts).

/** `GET /status` — a instância está pareada e o celular tem internet? */
export async function statusInstancia(): Promise<{
  connected?: boolean;
  smartphoneConnected?: boolean;
  error?: string;
} | null> {
  return (await zapiGet('status')) as { connected?: boolean } | null;
}

/** `GET /device` — qual número está pareado (confere se é mesmo o da clínica). */
export async function dadosDispositivo(): Promise<Record<string, unknown> | null> {
  return (await zapiGet('device')) as Record<string, unknown> | null;
}

/**
 * `GET /me` — dados da instância, incluindo as URLs de webhook configuradas e o
 * `receiveCallbackSentByMe`, que é o que faz o eco `fromMe` chegar até nós. Sem
 * essa flag ligada, a Bruna responder pelo celular NÃO pausa a IA.
 */
export async function dadosInstancia(): Promise<Record<string, unknown> | null> {
  return (await zapiGet('me')) as Record<string, unknown> | null;
}

/** Um chat/contato do aparelho, já reduzido ao mínimo — `name` e `notes` morrem aqui. */
export interface ChatBruto {
  /** só dígitos; string vazia quando o campo veio inválido */
  phone: string;
  isGroup: boolean;
  /** o chat veio sem `lastMessageTime` (só entra no relatório do import) */
  semData: boolean;
}

export interface Coleta {
  /** false = alguma página falhou depois das tentativas; a lista está INCOMPLETA */
  completo: boolean;
  chats: ChatBruto[];
  paginas: number;
  erro?: string;
}

interface OpcoesColeta {
  pageSize?: number;
  maxPaginas?: number;
  tentativas?: number;
}

/** Reduz o objeto cru da Z-API ao ChatBruto. Descarta name/notes/lastMessageTime
 *  aqui, na fronteira: o resto do sistema nunca chega a ver esses campos. */
function reduzir(item: unknown): ChatBruto {
  const c = (item ?? {}) as Record<string, unknown>;
  const bruto = typeof c.phone === 'string' ? c.phone : '';
  const t = c.lastMessageTime;
  return {
    phone: bruto,
    isGroup: c.isGroup === true || c.isGroup === 'true',
    semData: t == null || t === '' || t === 0 || t === '0',
  };
}

/**
 * Percorre um endpoint paginado da Z-API até o fim. Nunca lança: devolve
 * `completo: false` com o erro já sanitizado, porque uma lista parcial que se
 * apresenta como completa é o pior resultado possível aqui (o operador acha que
 * importou tudo e libera a IA em cima de conversas que ficaram de fora).
 *
 * O fim da paginação é por página VAZIA, por página repetida (API ignorando o
 * `page`) ou pelo teto. Nunca por "página menor que o pageSize": a doc não fixa
 * teto de `pageSize`, e se a API devolver 50 pra um pedido de 100, essa heurística
 * pararia na página 1 dando a lista por completa.
 */
async function coletarPaginado(path: string, opts: OpcoesColeta = {}): Promise<Coleta> {
  const pageSize = opts.pageSize ?? 100;
  const maxPaginas = opts.maxPaginas ?? 100;
  const tentativas = opts.tentativas ?? 3;

  const chats: ChatBruto[] = [];
  let anterior = '';
  let paginas = 0;

  for (let page = 1; page <= maxPaginas; page++) {
    let pagina: unknown = null;
    let ultimoErro: unknown = null;
    for (let tentativa = 1; tentativa <= tentativas; tentativa++) {
      try {
        pagina = await zapiGet(path, { page, pageSize });
        ultimoErro = null;
        break;
      } catch (err) {
        ultimoErro = err;
        if (tentativa < tentativas) await new Promise((r) => setTimeout(r, 400 * tentativa));
      }
    }
    if (ultimoErro) {
      return { completo: false, chats, paginas, erro: mensagemDeErro(ultimoErro) };
    }
    if (!Array.isArray(pagina) || pagina.length === 0) break;

    const reduzidos = pagina.map(reduzir);
    // API ignorando o `page` devolveria a mesma página pra sempre
    const assinatura = reduzidos.map((c) => c.phone).join(',');
    if (assinatura === anterior) break;
    anterior = assinatura;

    chats.push(...reduzidos);
    paginas = page;
  }

  return { completo: true, chats, paginas };
}

/** `GET /chats` — as conversas que existem no aparelho. */
export function coletarChats(opts?: OpcoesColeta): Promise<Coleta> {
  return coletarPaginado('chats', opts);
}

/**
 * `GET /contacts` — a agenda do aparelho. Pega quem a Bruna tem salvo mas cuja
 * conversa foi apagada (e por isso não aparece em `/chats`). Opcional no import.
 */
export function coletarContatos(opts?: OpcoesColeta): Promise<Coleta> {
  return coletarPaginado('contacts', opts);
}
