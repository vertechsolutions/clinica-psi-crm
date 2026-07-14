import { getPool } from './db';

/**
 * Cria o schema no boot (idempotente). Envolvido em pg_advisory_lock pra que, se
 * houver mais de uma instância subindo, só uma rode o DDL por vez.
 *
 * Tabelas:
 * - wa_conversations: estado da conversa por número (ficha de triagem acumulada).
 * - wa_messages: histórico de mensagens (monta o contexto pra IA); wamid UNIQUE
 *   faz a deduplicação dos webhooks reentregues pela Meta numa só tacada.
 * - app_config: config editável em runtime (o "raciocínio ativo" calibrado na tela
 *   e usado pelo webhook do WhatsApp).
 */
const MIGRATION_LOCK_KEY = 727_001;

export async function initSchema(): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS wa_conversations (
        wa_id       TEXT PRIMARY KEY,
        nome        TEXT,
        lead        JSONB,
        pronto      BOOLEAN NOT NULL DEFAULT FALSE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    // Colunas de handoff: quando a IA envia o formulário (enviarForm=true),
    // marcamos pausada=true e o webhook para de responder o paciente até a
    // equipe assumir. pausada_em fica de trilha pra auditoria/relatório.
    // ADD COLUMN IF NOT EXISTS é idempotente em bases já existentes.
    await client.query(`
      ALTER TABLE wa_conversations
        ADD COLUMN IF NOT EXISTS pausada     BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS pausada_em  TIMESTAMPTZ;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS wa_messages (
        id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        wa_id       TEXT NOT NULL,
        role        TEXT NOT NULL CHECK (role IN ('user','assistant')),
        content     TEXT NOT NULL,
        wamid       TEXT UNIQUE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_wa_messages_waid_created
        ON wa_messages (wa_id, created_at);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS app_config (
        key         TEXT PRIMARY KEY,
        value       TEXT NOT NULL,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    client.release();
  }
}
