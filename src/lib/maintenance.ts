import { query } from './db';
import { marcarLegadoEmLote } from './legado';

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

/**
 * A pausa vira supressão ANTES de o conteúdo sumir.
 *
 * Sem isto a retenção DESPAUSAVA a IA: apagada a linha de `wa_conversations`,
 * `isPaused` volta `false` (`conversation.ts`) e a Camila reassume, em silêncio,
 * um chat que a Bruna tinha tomado à mão. Levava 30 ou 90 dias e não deixava
 * rastro nenhum.
 *
 * Migrar pra `wa_legado` em vez de simplesmente poupar as conversas pausadas da
 * limpeza: pausada é, na maioria, handoff concluído — exatamente o dado de saúde
 * que se prometeu apagar no prazo. Manter a linha inteira trocaria um bug por um
 * estouro de retenção. O `wa_legado` já é, por desenho, o lugar onde uma decisão
 * de "não falar" sobrevive ao apagamento do conteúdo: guarda só o HMAC, sem
 * telefone e sem conteúdo, e por isso mesmo fica fora da retenção.
 */
async function preservarPausas(): Promise<number> {
  const { rows } = await query<{ wa_id: string }>(
    `SELECT wa_id FROM wa_conversations WHERE pausada = TRUE AND (${expiraWhere()})`,
  );
  if (rows.length === 0) return 0;
  // `marcarLegadoEmLote` e não `marcarLegado`: a versão best-effort engole o erro,
  // e aqui engolir significaria apagar a pausa logo em seguida. Se isto lançar, a
  // limpeza inteira do ciclo aborta — dado guardado um dia a mais é um estouro
  // limitado e logado; pausa perdida é permanente e invisível.
  await marcarLegadoEmLote(
    rows.map((r) => r.wa_id),
    'pausada',
  );
  console.log(`[maintenance] ${rows.length} conversa(s) pausada(s) expiraram — pausa preservada na lista de supressão.`);
  return rows.length;
}

/**
 * Apaga conversas e mensagens que passaram do prazo de retenção.
 *
 * A preservação das pausas roda PRIMEIRO e de propósito: se rodasse depois, a
 * consulta já não encontraria as linhas. Nunca rode `repararPacientesDaCamila`
 * (`legado.ts`) entre os dois passos — ele tira do legado quem aparece em
 * `wa_conversations`, e desfaria a migração que acabou de acontecer.
 */
export async function cleanupExpired(): Promise<{ conversas: number; mensagens: number }> {
  await preservarPausas();
  const msgs = await query(
    `DELETE FROM wa_messages WHERE wa_id IN (
       SELECT wa_id FROM wa_conversations WHERE ${expiraWhere()}
     )`,
  );
  const conv = await query(`DELETE FROM wa_conversations WHERE ${expiraWhere()}`);
  // Mensagem ÓRFÃ: `recordUserMessage` grava em wa_messages antes de existir linha
  // em wa_conversations (que só nasce no upsert, depois da resposta). Se o turno
  // morre no meio — o Gemini falha e o webhook cai no fallback —, aquela linha
  // fica fora da subquery acima e nunca expiraria. Varre pelo prazo mais longo.
  const orfas = await query(
    `DELETE FROM wa_messages m
      WHERE m.created_at < now() - interval '${RETENCAO_CONCLUIDA}'
        AND NOT EXISTS (SELECT 1 FROM wa_conversations c WHERE c.wa_id = m.wa_id)`,
  );
  // ids de envio só servem pra reconhecer o eco, que chega em segundos — depois
  // de um dia viram lixo. Sem isto a tabela cresceria pra sempre.
  await query(`DELETE FROM wa_outbound WHERE created_at < now() - interval '1 day'`);
  // `wa_legado` fica de fora de propósito: é lista de SUPRESSÃO (guarda o hash de
  // quem a IA não deve abordar) e expirá-la devolveria essas pessoas pra Camila em
  // silêncio. Não guarda conteúdo nem telefone — só o hash e um contador.
  return { mensagens: (msgs.rowCount ?? 0) + (orfas.rowCount ?? 0), conversas: conv.rowCount ?? 0 };
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
