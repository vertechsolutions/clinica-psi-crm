import { query } from './db';
import { runTriagem, type LeadExtraido } from './triagem';
import { DEFAULT_PROMPT } from './default-prompt';

/** Quantas mensagens recentes reidratam o contexto da IA a cada turno. */
const HISTORY_LIMIT = 30;

type Role = 'user' | 'assistant';

/** Raciocínio ativo: o que estiver salvo em app_config, senão o DEFAULT_PROMPT. */
export async function getActivePrompt(): Promise<string> {
  try {
    const { rows } = await query<{ value: string }>(
      `SELECT value FROM app_config WHERE key = 'system_prompt'`,
    );
    const v = rows[0]?.value?.trim();
    return v || DEFAULT_PROMPT;
  } catch (e) {
    console.error('[conversation] getActivePrompt falhou, usando DEFAULT_PROMPT', e);
    return DEFAULT_PROMPT;
  }
}

/** Salva o raciocínio ativo (o que a tela calibra vira o que o WhatsApp usa). */
export async function setActivePrompt(text: string): Promise<void> {
  await query(
    `INSERT INTO app_config (key, value, updated_at)
     VALUES ('system_prompt', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [text],
  );
}

/**
 * Registra a mensagem recebida do usuário. O UNIQUE(wamid) + ON CONFLICT DO
 * NOTHING deduplica os reenvios da Meta atomicamente: retorna true só na primeira
 * vez (processe), false se for reentrega (ignore).
 */
export async function recordUserMessage(waId: string, content: string, wamid: string): Promise<boolean> {
  const res = await query(
    `INSERT INTO wa_messages (wa_id, role, content, wamid)
     VALUES ($1, 'user', $2, $3)
     ON CONFLICT (wamid) DO NOTHING
     RETURNING id`,
    [waId, content, wamid],
  );
  return res.rowCount === 1;
}

export async function recordAssistantMessage(waId: string, content: string): Promise<void> {
  await query(
    `INSERT INTO wa_messages (wa_id, role, content) VALUES ($1, 'assistant', $2)`,
    [waId, content],
  );
}

async function loadHistory(waId: string): Promise<{ role: Role; content: string }[]> {
  const { rows } = await query<{ role: Role; content: string }>(
    `SELECT role, content FROM wa_messages
      WHERE wa_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
    [waId, HISTORY_LIMIT],
  );
  return rows.reverse(); // volta em ordem cronológica pra montar o prompt
}

export async function upsertConversation(
  waId: string,
  nome: string | undefined,
  lead: LeadExtraido,
  pronto: boolean,
): Promise<void> {
  await query(
    `INSERT INTO wa_conversations (wa_id, nome, lead, pronto, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (wa_id) DO UPDATE
       SET nome = COALESCE(EXCLUDED.nome, wa_conversations.nome),
           lead = EXCLUDED.lead,
           pronto = wa_conversations.pronto OR EXCLUDED.pronto,
           updated_at = now()`,
    [waId, nome ?? null, JSON.stringify(lead), pronto],
  );
}

export interface TurnoResposta {
  resposta: string;
  lead: LeadExtraido;
  pronto: boolean;
}

/**
 * Calcula a resposta pra uma mensagem já persistida: monta o contexto e chama a
 * triagem. NÃO grava nada — quem chama grava a resposta só APÓS o envio ao
 * WhatsApp dar certo (via persistReply), pra o histórico nunca ter uma resposta
 * que o paciente não recebeu.
 */
export async function computeReply(waId: string): Promise<TurnoResposta> {
  const history = await loadHistory(waId);
  const system = await getActivePrompt();
  const result = await runTriagem({ system, messages: history });
  const resposta = result.resposta?.trim() || 'Desculpa, pode repetir? Não consegui entender.';
  return { resposta, lead: result.lead, pronto: result.pronto };
}

/** Persiste a resposta do assistente + a ficha (chamar só após enviar ao WhatsApp). */
export async function persistReply(waId: string, nome: string | undefined, turno: TurnoResposta): Promise<void> {
  await recordAssistantMessage(waId, turno.resposta);
  await upsertConversation(waId, nome, turno.lead, turno.pronto);
}
