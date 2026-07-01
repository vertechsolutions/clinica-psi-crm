import { Pool, type PoolConfig, type PoolClient, type QueryResultRow } from 'pg';

/**
 * Pool singleton do Postgres (Railway), criado de forma LAZY: só instancia na
 * primeira query, nunca no import (senão o `next build` — que avalia os módulos
 * das rotas — quebraria sem DATABASE_URL). Guardado em globalThis pra sobreviver
 * ao hot-reload do `next dev`; em produção o cache de módulo já garante singleton.
 */
const connectionString = process.env.DATABASE_URL;

/**
 * SSL do Railway: a rede interna (*.railway.internal) é isolada, então SSL fica
 * desligado (e não paga egress). A URL pública (proxy.rlwy.net) cruza a internet
 * e usa cert self-signed, então liga SSL sem verificar a CA.
 */
function sslFor(cs: string): PoolConfig['ssl'] {
  if (cs.includes('.railway.internal')) return false;
  if (/sslmode=disable/.test(cs)) return false;
  return { rejectUnauthorized: false };
}

function createPool(): Pool {
  if (!connectionString) {
    throw new Error('DATABASE_URL não definida — configure o Postgres no Railway.');
  }
  const pool = new Pool({
    connectionString,
    ssl: sslFor(connectionString),
    max: 10, // soma dos max das réplicas < max_connections (100 default do Railway)
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000, // falha rápido se o DB estiver fora
    allowExitOnIdle: false, // servidor long-running: mantém o pool quente
  });
  // client ocioso que cai (ex.: Postgres reiniciando) não pode derrubar o processo
  pool.on('error', (err) => console.error('[pg] idle client error', err));
  return pool;
}

const g = globalThis as unknown as { __clinicaPool?: Pool };

/** Pool sob demanda: cria na primeira chamada, reusa depois. */
export function getPool(): Pool {
  if (!g.__clinicaPool) g.__clinicaPool = createPool();
  return g.__clinicaPool;
}

/** true quando há Postgres configurado (deixa o app subir sem DB, só sem webhook). */
export const hasDb = Boolean(connectionString);

/** Query parametrizada segura: SEMPRE $1,$2 + array de valores. Nunca concatenar. */
export function query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]) {
  return getPool().query<T>(text, params);
}

/** Transação: faz checkout de um client e SEMPRE o libera no finally. */
export async function withTransaction<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
