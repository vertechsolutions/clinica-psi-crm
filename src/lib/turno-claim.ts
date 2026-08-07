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
