/**
 * Lista de LEGADO — acesso ao banco. O núcleo puro (hash, variantes de número,
 * protegidos) está em `legado-core.ts`.
 *
 * O problema que isto resolve: a Z-API está pareada com o CELULAR da Bruna, que já
 * tinha centenas de conversas em andamento — pacientes que ela atende à mão, leads
 * antigos, contato pessoal. Sem uma lista de quem já era dela, esvaziar a
 * `WA_ALLOWLIST` faria a Camila cair em cima de todas essas conversas de uma vez:
 * contradizer a psicóloga, pedir Pix de primeira sessão a quem já é paciente, e —
 * de quebra — disparar dezenas de mensagens em minutos, que é o padrão com maior
 * risco de ban num número de API não-oficial.
 *
 * Os fail-safes daqui são deliberadamente assimétricos, no mesmo espírito de
 * `conversation.ts`: em dúvida sobre a INFRAESTRUTURA a Camila cala (a Bruna
 * atende como sempre atendeu); em dúvida sobre a CLASSIFICAÇÃO de um número
 * desconhecido, atende (senão o produto não existe).
 */
import { query } from './db';
import { ehProtegido, hashesDe, impressaoDigital, type OrigemLegado } from './legado-core';

const CHAVE = process.env.WA_LEGADO_CHAVE || '';

/** Chaves de `app_config` usadas aqui (a tabela já existia). */
const K_SNAPSHOT_EM = 'legado_snapshot_em';
const K_SNAPSHOT_TOTAL = 'legado_snapshot_total';
const K_CHAVE_FP = 'legado_chave_fp';
const K_CAMILA_MUDA = 'camila_muda';

/** Postgres: relação não existe (o schema ainda não rodou). */
const RELACAO_INEXISTENTE = '42P01';
const codigoDoErro = (e: unknown): string | undefined =>
  typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : undefined;

// ───────────────────────────── estado do gate ─────────────────────────────
// Três perguntas que não mudam a cada mensagem (botão vermelho, snapshot já
// rodado, chave certa) ficam em cache de 60s pra não virarem uma consulta extra
// por mensagem recebida.

interface EstadoGate {
  camilaMuda: boolean;
  snapshotEm: string | null;
  snapshotTotal: number | null;
  chaveFp: string | null;
}

let cache: { em: number; estado: EstadoGate } | null = null;
const TTL_CACHE = 60_000;

async function lerEstado(): Promise<EstadoGate> {
  if (cache && Date.now() - cache.em < TTL_CACHE) return cache.estado;
  const estado: EstadoGate = { camilaMuda: false, snapshotEm: null, snapshotTotal: null, chaveFp: null };
  try {
    const { rows } = await query<{ key: string; value: string }>(
      `SELECT key, value FROM app_config WHERE key = ANY($1::text[])`,
      [[K_CAMILA_MUDA, K_SNAPSHOT_EM, K_SNAPSHOT_TOTAL, K_CHAVE_FP]],
    );
    for (const r of rows) {
      if (r.key === K_CAMILA_MUDA) estado.camilaMuda = r.value === 'true';
      if (r.key === K_SNAPSHOT_EM) estado.snapshotEm = r.value;
      if (r.key === K_SNAPSHOT_TOTAL) estado.snapshotTotal = Number(r.value) || 0;
      if (r.key === K_CHAVE_FP) estado.chaveFp = r.value;
    }
    cache = { em: Date.now(), estado };
  } catch (e) {
    // Não cacheia o erro: a próxima mensagem tenta de novo. Quem decide o que
    // fazer sem esta informação é o gate (que cai no ehLegado, fail-closed).
    console.error('[legado] leitura do estado falhou', e);
  }
  return estado;
}

/** Invalida o cache — chamado por quem escreve (import, botão vermelho). */
function invalidarCache(): void {
  cache = null;
}

function allowlistVazia(): boolean {
  return (process.env.WA_ALLOWLIST || '').replace(/[\s,]/g, '') === '';
}

/**
 * Avisa a equipe UMA vez por assunto — o mesmo problema repete a cada mensagem
 * recebida, e um alerta por mensagem viraria spam no WhatsApp de quem precisa ler.
 */
const jaAlertados = new Set<string>();
async function alertarEquipe(chave: string, texto: string): Promise<void> {
  if (jaAlertados.has(chave)) return;
  if (jaAlertados.size > 200) jaAlertados.clear(); // não vira vazamento de memória
  jaAlertados.add(chave);
  try {
    const { sendInternalAlert } = await import('./whatsapp');
    const numeros = (process.env.NOTIFY_ALERT_NUMBERS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    await Promise.all(numeros.map((to) => sendInternalAlert(to, texto)));
  } catch (e) {
    console.error('[legado] alerta interno falhou', e);
  }
}

async function alertarConfig(motivo: string): Promise<void> {
  console.error(`[legado] ${motivo}`);
  await alertarEquipe(
    `config:${motivo}`,
    `⚠️ *Camila pausada por segurança*\n\n${motivo}\n\nA IA está muda até isso ser resolvido.`,
  );
}

/**
 * Contato com privacidade de número ligada: a Z-API entrega um identificador
 * anônimo (`@lid`) no lugar do telefone, e nenhuma lista baseada em telefone o
 * reconhece. Como não dá pra saber se é uma paciente antiga da Bruna ou um lead
 * novo, a IA não responde — mas alguém precisa saber que a pessoa escreveu, senão
 * o silêncio vira um lead (ou um paciente) perdido sem ninguém notar.
 */
export async function alertarContatoAnonimo(waId: string): Promise<void> {
  await alertarEquipe(
    `lid:${waId}`,
    '🔒 *Mensagem de contato com número oculto*\n\n' +
      'Alguém com a privacidade de número ativada no WhatsApp escreveu para a clínica. ' +
      'A Camila **não** respondeu: sem o telefone, ela não tem como saber se é um paciente ' +
      'que já está em atendimento ou alguém novo.\n\n' +
      'Dá uma olhada no WhatsApp e responde por lá. 💙',
  );
}

// ─────────────────────────────── consultas ───────────────────────────────

/**
 * Esse número já era atendido à mão pela Bruna? Consulta as duas grafias do
 * telefone (com e sem o 9º dígito) e, de quebra, incrementa um contador — é o
 * único rastro que sobra de quem está sendo calado, já que o gate retorna antes
 * de gravar qualquer mensagem. Contador, não histórico: sem data e sem conteúdo.
 *
 * Em ERRO devolve `true` (cala). Não é regressão: com o banco fora, o
 * `recordUserMessage` já lançava e o turno morria antes de qualquer envio. A
 * exceção é a tabela ainda não existir (schema não rodou), aí segue como hoje.
 */
export async function ehLegado(waId: string): Promise<boolean> {
  try {
    const res = await query(
      `UPDATE wa_legado SET tentativas = tentativas + 1 WHERE chave_hash = ANY($1::text[])`,
      [hashesDe(waId, CHAVE)],
    );
    return (res.rowCount ?? 0) > 0;
  } catch (e) {
    if (codigoDoErro(e) === RELACAO_INEXISTENTE) {
      console.error('[legado] tabela wa_legado ainda não existe — seguindo sem o filtro.');
      return false;
    }
    console.error('[legado] consulta falhou, calando por precaução', e);
    return true;
  }
}

/**
 * Por que a Camila ficou muda. Só `'legado'` é operação normal — os outros três
 * significam que ela está calada com TODO MUNDO, e essa diferença é o que a
 * vigília depois da virada precisa enxergar no log.
 */
export type MotivoSilencio = 'legado' | 'botao-vermelho' | 'sem-snapshot' | 'chave-divergente';

/**
 * O gate do webhook, em ordem:
 *  1. equipe nunca é calada (nem um alerta interno cujo registro de envio falhou);
 *  2. botão vermelho ligado → silêncio total, sem restart;
 *  3. allowlist vazia E snapshot nunca rodado → silêncio: é o acidente de ordem do
 *     rollout (abrir a torneira antes de importar a lista), e o custo de deixá-lo
 *     passar é a IA em cima de todas as conversas humanas ao mesmo tempo;
 *  4. chave trocada → silêncio (os hashes não casariam mais e a lista inteira
 *     viraria letra morta em silêncio, que é o pior jeito de falhar);
 *  5. o veredito da lista.
 *
 * `null` = pode atender.
 */
export async function deveIgnorarPorLegado(waId: string): Promise<MotivoSilencio | null> {
  if (ehProtegido(waId, process.env)) return null;

  const estado = await lerEstado();
  if (estado.camilaMuda) return 'botao-vermelho';

  if (allowlistVazia() && !estado.snapshotEm) {
    await alertarConfig('WA_ALLOWLIST está vazia e a lista de conversas antigas nunca foi importada.');
    return 'sem-snapshot';
  }
  if (estado.chaveFp && estado.chaveFp !== impressaoDigital(CHAVE)) {
    await alertarConfig('WA_LEGADO_CHAVE não confere com a que gerou a lista de conversas antigas.');
    return 'chave-divergente';
  }
  return (await ehLegado(waId)) ? 'legado' : null;
}

/** Diagnóstico ("por que a Camila está muda aqui?") — não mexe no contador. */
export async function consultarLegado(waId: string): Promise<{
  legado: boolean;
  origem?: OrigemLegado;
  tentativas?: number;
}> {
  const { rows } = await query<{ origem: OrigemLegado; tentativas: number }>(
    `SELECT origem, tentativas FROM wa_legado WHERE chave_hash = ANY($1::text[]) LIMIT 1`,
    [hashesDe(waId, CHAVE)],
  );
  const r = rows[0];
  return r ? { legado: true, origem: r.origem, tentativas: r.tentativas } : { legado: false };
}

// ─────────────────────────────── escritas ───────────────────────────────

/** Marca um número (todas as grafias). Best-effort: nunca derruba o turno. */
export async function marcarLegado(waId: string, origem: OrigemLegado): Promise<void> {
  try {
    await marcarLegadoEmLote([waId], origem);
  } catch (e) {
    console.error('[legado] marcação falhou', e);
  }
}

/**
 * Números que a Camila JÁ atendeu — não podem entrar na lista de legado.
 *
 * Antes da virada isso não muda nada (nenhum chat daquele aparelho era da IA),
 * mas a partir do momento em que a allowlist é esvaziada, re-rodar o import
 * marcaria como "conversa antiga da Bruna" justamente os pacientes que a Camila
 * acabou de conquistar — e ela ficaria muda pra eles, em silêncio.
 */
export async function jaAtendidosPelaCamila(telefones: string[]): Promise<Set<string>> {
  if (telefones.length === 0) return new Set();
  const { rows } = await query<{ wa_id: string }>(
    `SELECT DISTINCT wa_id FROM wa_messages WHERE wa_id = ANY($1::text[])
     UNION
     SELECT wa_id FROM wa_conversations WHERE wa_id = ANY($1::text[])`,
    [telefones],
  );
  return new Set(rows.map((r) => r.wa_id));
}

/**
 * Separa o que ainda não está na lista. Serve pro import a seco (DRY) dizer
 * quantos números NOVOS entrariam antes de gravar qualquer coisa.
 */
export async function classificarNovos(
  telefones: string[],
): Promise<{ novos: string[]; jaNaLista: number }> {
  const porTelefone = telefones.map((t) => ({ t, hashes: hashesDe(t, CHAVE) }));
  const todos = [...new Set(porTelefone.flatMap((p) => p.hashes))];
  if (todos.length === 0) return { novos: [], jaNaLista: 0 };

  const { rows } = await query<{ chave_hash: string }>(
    `SELECT chave_hash FROM wa_legado WHERE chave_hash = ANY($1::text[])`,
    [todos],
  );
  const existentes = new Set(rows.map((r) => r.chave_hash));
  const novos = porTelefone.filter((p) => !p.hashes.some((h) => existentes.has(h))).map((p) => p.t);
  return { novos, jaNaLista: telefones.length - novos.length };
}

/** Insere em lote. Devolve quantas linhas eram novas (idempotente). */
export async function marcarLegadoEmLote(telefones: string[], origem: OrigemLegado): Promise<number> {
  const hashes = [...new Set(telefones.flatMap((t) => hashesDe(t, CHAVE)))];
  if (hashes.length === 0) return 0;
  const res = await query(
    `INSERT INTO wa_legado (chave_hash, origem)
     SELECT unnest($1::text[]), $2
     ON CONFLICT (chave_hash) DO NOTHING`,
    [hashes, origem],
  );
  return res.rowCount ?? 0;
}

/** Tira o número da lista — "essa conversa agora é da Camila". */
export async function removerLegado(waId: string): Promise<boolean> {
  const res = await query(`DELETE FROM wa_legado WHERE chave_hash = ANY($1::text[])`, [
    hashesDe(waId, CHAVE),
  ]);
  return (res.rowCount ?? 0) > 0;
}

async function setConfig(key: string, value: string): Promise<void> {
  await query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value],
  );
  invalidarCache();
}

/** Carimba o import concluído: é o que destrava a virada (ver deveIgnorarPorLegado). */
export async function registrarSnapshot(total: number): Promise<void> {
  await setConfig(K_SNAPSHOT_EM, new Date().toISOString());
  await setConfig(K_SNAPSHOT_TOTAL, String(total));
  await setConfig(K_CHAVE_FP, impressaoDigital(CHAVE));
}

/** Botão vermelho: cala a Camila em todos os números, em <1s e sem restart. */
export async function setCamilaMuda(muda: boolean): Promise<void> {
  await setConfig(K_CAMILA_MUDA, muda ? 'true' : 'false');
}

export interface StatusLegado {
  total: number;
  snapshotEm: string | null;
  snapshotTotal: number | null;
  camilaMuda: boolean;
  chaveConfigurada: boolean;
  chaveOk: boolean;
  /** quantos números da lista tentaram falar desde a virada, e quantas vezes */
  numerosQueTentaram: number;
  tentativas: number;
}

export async function statusLegado(): Promise<StatusLegado> {
  const estado = await lerEstado();
  const { rows } = await query<{ total: string; com_tentativa: string; tentativas: string }>(
    `SELECT count(*) AS total,
            count(*) FILTER (WHERE tentativas > 0) AS com_tentativa,
            COALESCE(sum(tentativas), 0) AS tentativas
       FROM wa_legado`,
  );
  const r = rows[0];
  return {
    total: Number(r?.total ?? 0),
    snapshotEm: estado.snapshotEm,
    snapshotTotal: estado.snapshotTotal,
    camilaMuda: estado.camilaMuda,
    chaveConfigurada: Boolean(CHAVE),
    chaveOk: !estado.chaveFp || estado.chaveFp === impressaoDigital(CHAVE),
    numerosQueTentaram: Number(r?.com_tentativa ?? 0),
    tentativas: Number(r?.tentativas ?? 0),
  };
}

/** Só pros testes: zera o cache do estado entre cenários. */
export function __resetCacheLegado(): void {
  invalidarCache();
  jaAlertados.clear();
}
