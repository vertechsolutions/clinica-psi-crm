/**
 * Claim de turno: a serialização que garante que dois turnos concorrentes do
 * mesmo número nunca respondam os dois.
 *
 * É a metade "entre processos" da correção do print de 06/08/2026 (a Camila
 * mandou o mesmo par de bolhas duas vezes às 17:59). A outra metade é o debounce
 * em memória (`turno.ts`), que junta a rajada; este aqui é a rede para o que a
 * memória não vê: duas requisições que escaparam da mesma janela, um deploy com
 * dois containers sobrepostos, a varredura de boot cruzando com o webhook vivo.
 *
 * CLAIM OTIMISTA COM TTL, não advisory lock: o `pg_advisory_lock` do `initSchema`
 * segura um client do pool pelo tempo inteiro da seção crítica, e um turno dura
 * dezenas de segundos (duas chamadas ao Gemini + até 4 bolhas com 900ms entre
 * elas). Com pool de 10 (`db.ts:29`), meia dúzia de leads simultâneos esgotaria
 * as conexões e derrubaria o resto do app. Aqui cada operação é uma query e
 * pronto — nada fica segurado.
 */
import { randomUUID } from 'node:crypto';
import { query } from './db';

/**
 * Teto de segurança, NÃO parâmetro de negócio: só existe para que um claim de um
 * processo que morreu no meio do turno volte a ser reivindicável. Um turno real
 * leva 20-40s; 90s dá folga larga sem deixar um número mudo por muito tempo.
 *
 * O orçamento de retry do `turno.ts` é calibrado contra esta constante — um
 * ciclo perdedor precisa sobreviver mais tempo do que a vida máxima do vencedor.
 */
export const TURNO_TTL_SEGUNDOS = 90;

/**
 * Tenta assumir o turno de `waId`. Devolve o token do titular, ou `null` se
 * outro turno já está com ele.
 *
 * `INSERT ... ON CONFLICT`, e não `UPDATE`: a linha em `wa_conversations` só
 * nasce no `persistReply`, então um `UPDATE` puro nunca pegaria o PRIMEIRO
 * contato — que é exatamente o caso do print. Mesmo raciocínio (e mesmo idioma)
 * do `pauseConversation` em `conversation.ts:138-146`.
 *
 * Sob READ COMMITTED o segundo concorrente bloqueia na inserção especulativa do
 * índice único, espera o commit do primeiro e reavalia o `WHERE` do `DO UPDATE`
 * contra a versão já commitada — então exatamente um dos dois sai com token. É a
 * mesma garantia que o `ON CONFLICT (wamid) DO NOTHING RETURNING id` do
 * `recordUserMessage` já entrega em produção.
 */
export async function claimTurno(waId: string): Promise<string | null> {
  const token = randomUUID();
  // ATENÇÃO AO REVISOR: este SQL NÃO pode tocar `updated_at`. Três coisas leem
  // essa coluna e quebrariam em silêncio:
  //   · `followup.findColdLeads` filtra por updated_at < now() - 24h → o
  //     reengajamento seria adiado a cada turno, e o lead frio nunca esfriaria;
  //   · `maintenance.cleanupExpired` usa updated_at como relógio da retenção →
  //     estenderíamos a guarda de dado de saúde (LGPD) sem ninguém decidir isso;
  //   · o painel admin ordena por updated_at.
  const { rows } = await query<{ wa_id: string }>(
    `INSERT INTO wa_conversations (wa_id, turno_ate, turno_token)
     VALUES ($1, now() + interval '${TURNO_TTL_SEGUNDOS} seconds', $2)
     ON CONFLICT (wa_id) DO UPDATE
        SET turno_ate   = now() + interval '${TURNO_TTL_SEGUNDOS} seconds',
            turno_token = EXCLUDED.turno_token
      WHERE wa_conversations.turno_ate IS NULL
         OR wa_conversations.turno_ate < now()
     RETURNING wa_id`,
    [waId, token],
  );
  return rows.length === 1 ? token : null;
}

/**
 * Devolve o turno. Só zera se o token bater: se ESTE processo ficou pendurado
 * além do TTL e outro turno já reivindicou, apagar o claim novo faria justamente
 * a dupla resposta que a trava existe para impedir.
 *
 * Best-effort e nunca lança — roda no `finally` do turno, e uma falha aqui não
 * pode engolir o erro real nem impedir o resto do desfecho. O pior caso de não
 * liberar é o número esperar o TTL, que é o que o TTL existe para resolver.
 */
export async function releaseTurno(waId: string, token: string): Promise<void> {
  try {
    await query(
      `UPDATE wa_conversations
          SET turno_ate = NULL, turno_token = NULL
        WHERE wa_id = $1 AND turno_token = $2`,
      [waId, token],
    );
  } catch (e) {
    console.error('[claim] release falhou (best-effort, o TTL resolve)', e);
  }
}

/**
 * Ainda somos o titular? Checado imediatamente antes do primeiro byte que sai
 * para o paciente: se outro turno assumiu enquanto este gerava a resposta,
 * abortar em silêncio é melhor que mandar a mensagem duas vezes.
 *
 * Casa SÓ pelo token, sem `AND turno_ate > now()`. O token é a identidade; a
 * expiração governa apenas quem pode ADQUIRIR. Exigir o TTL aqui abortaria um
 * turno lento mas INCONTESTADO — um falso aborto que faria o lead ficar sem
 * resposta sem que ninguém tivesse assumido o lugar dele.
 *
 * Falha FECHADO (`false`) em erro de banco, na mesma assimetria declarada em
 * `legado.ts`: em dúvida sobre a infraestrutura, a Camila cala. Silêncio tem
 * conserto pela equipe; mensagem duplicada no WhatsApp do paciente, não.
 */
export async function aindaTitular(waId: string, token: string): Promise<boolean> {
  try {
    const { rows } = await query(
      `SELECT 1 FROM wa_conversations WHERE wa_id = $1 AND turno_token = $2`,
      [waId, token],
    );
    return rows.length === 1;
  } catch (e) {
    console.error('[claim] aindaTitular falhou — abortando o envio por precaução', e);
    return false;
  }
}

/** Por que este turno pode (ou não pode) mandar bolha. */
export type Voz = 'ok' | 'pausada' | 'sem-titularidade' | 'erro';

/** O recorte da linha de `wa_conversations` que a decisão consome. */
export interface LinhaDaVez {
  pausada: boolean | null;
  turno_token: string | null;
}

/**
 * A decisão, dada a linha do banco — pura, e é aqui que mora a correção do
 * relato da Bruna de 11/08/2026 ("a IA não desativa quando eu assumo").
 *
 * A ordem dos testes não é arbitrária. A pausa é checada ANTES da titularidade
 * porque quando as duas valem o motivo que a operação precisa ler no log é o
 * humano que assumiu, não a corrida de claim — se a Bruna reclamar de novo, é
 * essa linha que responde.
 *
 * Linha ausente conta como falta de titularidade: durante um turno ela SEMPRE
 * existe (o `claimTurno` a cria), então sumir no meio só acontece por retenção
 * ou apagamento LGPD, e nos dois casos calar é a leitura defensável.
 *
 * Sem `turno_ate > now()`, pelo mesmo motivo já escrito no `aindaTitular`: o
 * token é a identidade, a expiração governa apenas quem pode ADQUIRIR.
 */
export function decidirVoz(linha: LinhaDaVez | undefined, token: string): Exclude<Voz, 'erro'> {
  if (!linha) return 'sem-titularidade';
  if (linha.pausada === true) return 'pausada';
  if (linha.turno_token !== token) return 'sem-titularidade';
  return 'ok';
}

/**
 * As duas perguntas do portão de saída — "ainda sou o titular?" e "a conversa
 * continua com a IA?" — num único SELECT.
 *
 * Uma query só, e não `isPaused()` + `aindaTitular()`, por CORREÇÃO e não por
 * economia: duas leituras abrem uma janela entre elas em que a pausa cai e
 * passa despercebida. Uma linha lida uma vez responde as duas contra o mesmo
 * snapshot.
 *
 * Substitui o `aindaTitular` nos call sites do `turno.ts`; a função antiga
 * continua exportada porque a semântica "só o token" é o que o
 * `test-claim-live.ts` prova sobre o claim isolado.
 *
 * Falha FECHADO (`'erro'` → ninguém fala). A assimetria aqui é diferente da do
 * anti-bot: o risco não é emudecer quem pede ajuda — o turno perdido é refeito
 * pela varredura de boot —, é falar por cima da psicóloga num atendimento que
 * ela assumiu, e isso o WhatsApp não desfaz.
 */
export async function podeFalar(waId: string, token: string): Promise<Voz> {
  try {
    const { rows } = await query<LinhaDaVez>(
      `SELECT pausada, turno_token FROM wa_conversations WHERE wa_id = $1`,
      [waId],
    );
    return decidirVoz(rows[0], token);
  } catch (e) {
    console.error('[claim] podeFalar falhou — abortando o envio por precaução', e);
    return 'erro';
  }
}
