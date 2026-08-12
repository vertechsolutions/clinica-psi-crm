import { getPool } from './db';

/**
 * Cria o schema no boot (idempotente). Envolvido em pg_advisory_lock pra que, se
 * houver mais de uma instância subindo, só uma rode o DDL por vez.
 *
 * Tabelas:
 * - wa_conversations: estado da conversa por número (ficha de triagem acumulada).
 * - wa_messages: histórico de mensagens (monta o contexto pra IA); wamid UNIQUE
 *   faz a deduplicação dos webhooks reentregues numa só tacada.
 * - wa_outbound: ids do que a gente enviou, pra distinguir o eco da própria
 *   Camila da Bruna digitando no celular (Z-API entrega os dois como fromMe).
 * - wa_legado: hash dos números que já eram atendidos à mão pela Bruna antes da
 *   Camila — a IA fica muda pra eles.
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

    // Colunas de follow-up proativo: quantas vezes já reengajamos esse lead e
    // quando foi a última — pra não spammar. Idempotente.
    await client.query(`
      ALTER TABLE wa_conversations
        ADD COLUMN IF NOT EXISTS followup_count    INT NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS followup_last_at  TIMESTAMPTZ;
    `);

    // Claim de turno: a trava que garante que dois turnos concorrentes do mesmo
    // número nunca respondam os dois (o bug do print de 06/08 — o mesmo par de
    // bolhas enviado duas vezes). `turno_token` é a identidade de quem detém o
    // turno; `turno_ate` é só o teto de segurança que permite reivindicar um
    // claim de um processo que morreu. Ver `turno-claim.ts`. Idempotente.
    await client.query(`
      ALTER TABLE wa_conversations
        ADD COLUMN IF NOT EXISTS turno_ate   TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS turno_token TEXT;
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

    // Ids das mensagens que NÓS enviamos. A Z-API devolve tudo que sai do número
    // como eco (fromMe=true), inclusive o que a própria Camila mandou — sem esta
    // lista, cada resposta da IA pareceria "a Bruna assumiu a conversa" e
    // pausaria o atendimento sozinha. Limpa junto com o resto no maintenance.
    await client.query(`
      CREATE TABLE IF NOT EXISTS wa_outbound (
        wamid       TEXT PRIMARY KEY,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_wa_outbound_created ON wa_outbound (created_at);
    `);

    // Lista de LEGADO: as conversas que já eram atendidas à mão pela Bruna quando
    // a Camila entrou no número profissional dela. Guarda só o HMAC do telefone —
    // são centenas de pessoas que nunca pediram triagem, e a tabela só faz
    // igualdade exata, então o número em claro não acrescenta nada.
    //
    // Tabela separada de wa_conversations de propósito: o cleanupExpired apaga
    // aquelas linhas em 30/90 dias, e o número voltaria a ser "novo" em silêncio.
    // Pelo mesmo motivo esta tabela NÃO entra na rotina de retenção: é lista de
    // supressão, cuja finalidade é justamente não tratar (ver src/lib/maintenance.ts).
    // `tentativas` é um contador SEM carimbo de hora, de propósito: registrar
    // quando cada número escreveu seria guardar metadado de comunicação de gente
    // que não é paciente. O contador sozinho responde a única pergunta que a
    // operação precisa fazer — "tem alguém insistindo e sendo calado por engano?".
    await client.query(`
      CREATE TABLE IF NOT EXISTS wa_legado (
        chave_hash          TEXT PRIMARY KEY,
        origem              TEXT NOT NULL DEFAULT 'snapshot'
                            CHECK (origem IN ('snapshot','contato','eco','manual')),
        tentativas          INT NOT NULL DEFAULT 0,
        criado_em           TIMESTAMPTZ NOT NULL DEFAULT date_trunc('day', now())
      );
    `);
    // bases criadas antes desta decisão: some com a coluna de horário
    await client.query(`ALTER TABLE wa_legado DROP COLUMN IF EXISTS ultima_tentativa_em;`);
    // 11/08/2026: a pausa por atendimento humano passa a sobreviver à retenção
    // migrando pra cá (ver preservarPausas em maintenance.ts). Bases antigas têm
    // o CHECK sem 'pausada' — drop + add porque o Postgres não tem ALTER CHECK,
    // e nesta ordem a operação é idempotente a cada boot.
    await client.query(`ALTER TABLE wa_legado DROP CONSTRAINT IF EXISTS wa_legado_origem_check;`);
    await client.query(
      `ALTER TABLE wa_legado ADD CONSTRAINT wa_legado_origem_check
         CHECK (origem IN ('snapshot','contato','eco','manual','pausada'));`,
    );

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
