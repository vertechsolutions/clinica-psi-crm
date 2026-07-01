import { query } from './db';

/**
 * Retenção de dados (LGPD Art. 6 III / Art. 16). São dados sensíveis de saúde,
 * então guardamos só o necessário e apagamos após o ciclo de triagem:
 * - conversa concluída (pronto = true): 90 dias após o último contato.
 * - conversa incompleta (pronto = false): 30 dias após o último contato.
 */
const RETENCAO_CONCLUIDA = "90 days";
const RETENCAO_INCOMPLETA = "30 days";

function expiraWhere(alias = 'wa_conversations'): string {
  return `(${alias}.pronto = TRUE AND ${alias}.updated_at < now() - interval '${RETENCAO_CONCLUIDA}')
       OR (${alias}.pronto = FALSE AND ${alias}.updated_at < now() - interval '${RETENCAO_INCOMPLETA}')`;
}

/** Apaga conversas e mensagens que passaram do prazo de retenção. */
export async function cleanupExpired(): Promise<{ conversas: number; mensagens: number }> {
  const msgs = await query(
    `DELETE FROM wa_messages WHERE wa_id IN (
       SELECT wa_id FROM wa_conversations WHERE ${expiraWhere()}
     )`,
  );
  const conv = await query(`DELETE FROM wa_conversations WHERE ${expiraWhere()}`);
  return { mensagens: msgs.rowCount ?? 0, conversas: conv.rowCount ?? 0 };
}

/**
 * Direito ao apagamento (LGPD Art. 18 VI): remove TODOS os dados de um número.
 * Usado pelo endpoint admin quando o paciente solicita a exclusão.
 */
export async function deletePatientData(waId: string): Promise<{ conversas: number; mensagens: number }> {
  const msgs = await query(`DELETE FROM wa_messages WHERE wa_id = $1`, [waId]);
  const conv = await query(`DELETE FROM wa_conversations WHERE wa_id = $1`, [waId]);
  return { mensagens: msgs.rowCount ?? 0, conversas: conv.rowCount ?? 0 };
}

/**
 * Agenda a limpeza no boot e a cada 24h. Como o Railway roda um container
 * persistente, o setInterval sobrevive; .unref() evita segurar o processo vivo.
 */
export function scheduleCleanup(): void {
  const run = () =>
    cleanupExpired()
      .then((r) => {
        if (r.conversas || r.mensagens)
          console.log(`[maintenance] retenção: ${r.conversas} conversas / ${r.mensagens} mensagens expiradas removidas`);
      })
      .catch((e) => console.error('[maintenance] limpeza falhou', e));
  run();
  const timer = setInterval(run, 24 * 60 * 60 * 1000);
  timer.unref?.();
}
