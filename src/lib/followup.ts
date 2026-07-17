/**
 * Proatividade (goal 3): reengaja leads que demonstraram interesse mas sumiram.
 * Cron in-process (como o cleanup LGPD). Dentro da janela de 24h do WhatsApp
 * manda a mensagem 7 do FAQ (texto livre); fora da janela usa um template
 * aprovado. Gate por env: FOLLOWUP_ENABLED e FOLLOWUP_TEMPLATE_NAME.
 */
import { query } from './db';
import { sendText, sendTemplate } from './whatsapp';

/** Mensagem 7 do FAQ da Bruna — reengajamento dentro da janela de 24h. */
export const MENSAGEM_RETENCAO =
  'Olá! Não tive seu retorno, e estou passando para saber se você ainda deseja agendar sua primeira sessão. Podemos continuar o atendimento?';

const JANELA_MS = 24 * 60 * 60 * 1000;
const MAX_FOLLOWUPS = 2; // no máximo 2 reengajamentos por lead

/** LGPD: nunca logar o telefone inteiro. Só os últimos 4 dígitos pra referência. */
const mask = (waId: string) => `***${waId.slice(-4)}`;

export type Canal = 'freeform' | 'template';

/** Decide o canal pelo tempo desde a última mensagem RECEBIDA do paciente. */
export function decideChannel(lastInboundAt: Date | null, now: Date): Canal {
  if (!lastInboundAt) return 'template';
  return now.getTime() - lastInboundAt.getTime() < JANELA_MS ? 'freeform' : 'template';
}

interface ColdLead {
  wa_id: string;
  followup_count: number;
  last_inbound: Date | null;
}

/**
 * Leads frios: interessados (têm motivação captada), não prontos, não pausados,
 * parados há +24h, abaixo do teto de follow-ups e com respiro de 24h desde o
 * último. LIMIT baixo pra não estourar rate limit da Meta num tick só.
 */
async function findColdLeads(): Promise<ColdLead[]> {
  const { rows } = await query<ColdLead>(
    `SELECT c.wa_id, c.followup_count,
            (SELECT max(m.created_at) FROM wa_messages m
              WHERE m.wa_id = c.wa_id AND m.role = 'user') AS last_inbound
       FROM wa_conversations c
      WHERE c.pausada = FALSE
        AND c.pronto = FALSE
        AND c.updated_at < now() - interval '24 hours'
        AND c.followup_count < $1
        AND (c.followup_last_at IS NULL OR c.followup_last_at < now() - interval '24 hours')
        AND c.lead ->> 'motivacao' IS NOT NULL
      ORDER BY c.updated_at ASC
      LIMIT 25`,
    [MAX_FOLLOWUPS],
  );
  return rows;
}

async function marcarEnviado(waId: string): Promise<void> {
  await query(
    `UPDATE wa_conversations
        SET followup_count = followup_count + 1, followup_last_at = now(), updated_at = now()
      WHERE wa_id = $1`,
    [waId],
  );
}

/** Roda um ciclo de follow-up. Retorna quantos foram reengajados. */
export async function runFollowup(now = new Date()): Promise<number> {
  const templateName = process.env.FOLLOWUP_TEMPLATE_NAME;
  const leads = await findColdLeads();
  let enviados = 0;
  for (const lead of leads) {
    const canal = decideChannel(lead.last_inbound ? new Date(lead.last_inbound) : null, now);
    try {
      if (canal === 'freeform') {
        await sendText(lead.wa_id, MENSAGEM_RETENCAO);
      } else if (templateName) {
        await sendTemplate(lead.wa_id, templateName);
      } else {
        console.warn(`[followup] ${mask(lead.wa_id)} fora da janela e sem FOLLOWUP_TEMPLATE_NAME — pulando.`);
        continue;
      }
      await marcarEnviado(lead.wa_id);
      enviados++;
    } catch (e) {
      console.error(`[followup] falha ao reengajar ${mask(lead.wa_id)}`, e);
    }
  }
  if (enviados) console.log(`[followup] ${enviados} lead(s) reengajado(s).`);
  return enviados;
}

/**
 * Agenda o follow-up a cada 1h (como o cleanup). OPT-IN: só liga com
 * FOLLOWUP_ENABLED=true explícito — decisão do piloto (17/07): reengajamento
 * proativo fica desligado até a Bruna aprovar cadência + template Meta.
 * .unref() pra não segurar o processo. Roda no container persistente do Railway.
 */
export function scheduleFollowup(): void {
  if (process.env.FOLLOWUP_ENABLED !== 'true') {
    console.log('[followup] desativado — ligue com FOLLOWUP_ENABLED=true quando o template Meta estiver aprovado.');
    return;
  }
  const run = () => runFollowup().catch((e) => console.error('[followup] ciclo falhou', e));
  const timer = setInterval(run, 60 * 60 * 1000);
  timer.unref?.();
}
