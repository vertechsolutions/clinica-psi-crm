/**
 * Teste de ORQUESTRAÇÃO: sobe o app de verdade e bate HTTP no webhook, como a
 * Z-API faz. É o único teste que exercita a ORDEM das decisões do handler —
 * autenticação, allowlist, dedup, eco `fromMe` e pausa — que hoje não tem
 * cobertura nenhuma e é onde a estreia pode quebrar.
 *
 * Roda contra o Postgres DE TESTE (`TEST_DATABASE_URL`), nunca o de produção.
 *
 * Os casos foram escolhidos pra NÃO chegarem no Gemini (conversa pausada grava e
 * cala; eco não gera resposta), então roda em segundos e não gasta cota. O
 * caminho que gera resposta de verdade é coberto por `sim-conversa`/`test-triagem`.
 *
 * Rodar:  npm run test:webhook
 */
import assert from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';

const TEST_URL = process.env.TEST_DATABASE_URL?.trim();
if (!TEST_URL) {
  console.error('TEST_DATABASE_URL ausente — ver instruções em scripts/test-db-live.ts.');
  process.exit(1);
}

const PORTA = 3987;
const SEGREDO = 'segredo-de-teste-do-webhook';
const BASE = `http://127.0.0.1:${PORTA}`;
const WA_PACIENTE = '5500000000011'; // na allowlist
const WA_FORA = '5500000000099'; // fora da allowlist
const WA_PESSOAL = '5500000000012'; // a Bruna fala com alguém que nunca procurou a clínica

const env = {
  ...process.env,
  DATABASE_URL: TEST_URL,
  WA_PROVIDER: 'zapi',
  ZAPI_WEBHOOK_SECRET: SEGREDO,
  ZAPI_INSTANCE_ID: 'INSTTEST',
  ZAPI_INSTANCE_TOKEN: 'TOKTEST',
  WA_ALLOWLIST: `${WA_PACIENTE},${WA_PESSOAL}`,
  NODE_ENV: 'development' as const,
  PORT: String(PORTA),
};

const post = (body: unknown, comSegredo = true) =>
  fetch(`${BASE}/api/whatsapp/webhook${comSegredo ? `?s=${SEGREDO}` : ''}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function subirServidor(): Promise<ChildProcess> {
  const proc = spawn('npx', ['next', 'dev', '--webpack', '-p', String(PORTA)], {
    env,
    shell: true,
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    await espera(1000);
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return proc;
    } catch {
      /* ainda subindo */
    }
  }
  proc.kill();
  throw new Error('o servidor não subiu em 60s');
}

async function main() {
  process.env.DATABASE_URL = TEST_URL;
  const { query, getPool } = await import('../src/lib/db');
  const { initSchema } = await import('../src/lib/schema');
  const conv = await import('../src/lib/conversation');
  const { deletePatientData } = await import('../src/lib/maintenance');

  await initSchema();
  for (const wa of [WA_PACIENTE, WA_FORA, WA_PESSOAL]) await deletePatientData(wa);

  const contar = async (waId: string) => {
    const { rows } = await query<{ n: string }>(`SELECT count(*) AS n FROM wa_messages WHERE wa_id = $1`, [waId]);
    return Number(rows[0].n);
  };

  console.log('subindo o app...');
  const proc = await subirServidor();
  try {
    const msg = (over: Record<string, unknown>) => ({
      phone: WA_PACIENTE,
      messageId: 'X1',
      momment: 1754300000000,
      isGroup: false,
      type: 'ReceivedCallback',
      text: { message: 'oi' },
      ...over,
    });

    // ── autenticação: fail-closed ──────────────────────────────────────────────
    assert.strictEqual((await post(msg({}), false)).status, 401, 'sem segredo → 401');
    assert.strictEqual(
      (await fetch(`${BASE}/api/whatsapp/webhook?s=errado`, { method: 'POST', body: '{}' })).status,
      401,
      'segredo errado → 401',
    );

    // ── allowlist: número fora não é atendido NEM gravado ──────────────────────
    assert.strictEqual((await post(msg({ phone: WA_FORA, messageId: 'F1' }))).status, 200);
    await espera(1500);
    assert.strictEqual(await contar(WA_FORA), 0, 'conversa de fora da allowlist não entra no banco');

    // ── recibo de entrega não é fala de ninguém ────────────────────────────────
    await post({ type: 'DeliveryCallback', phone: WA_PACIENTE, messageId: 'D1', zaapId: 'Z1', status: 'SENT' });
    await espera(1000);
    assert.strictEqual(await contar(WA_PACIENTE), 0, 'DeliveryCallback ignorado');

    // ── mensagem do paciente com a conversa PAUSADA: grava e cala ──────────────
    // (pausar antes evita chamar o Gemini — o objetivo aqui é a gravação e o dedup)
    await conv.pauseConversation(WA_PACIENTE);
    await post(msg({ messageId: 'P1', text: { message: 'oi, quero marcar' } }));
    await espera(2500);
    assert.strictEqual(await contar(WA_PACIENTE), 1, 'mensagem do paciente gravada mesmo pausada');

    // reentrega do MESMO messageId não duplica
    await post(msg({ messageId: 'P1', text: { message: 'oi, quero marcar' } }));
    await espera(2000);
    assert.strictEqual(await contar(WA_PACIENTE), 1, 'dedup por messageId');

    // ── eco da própria Camila: id registrado → ignora, NÃO pausa ───────────────
    await conv.resumeConversation(WA_PACIENTE);
    await conv.registrarEnvios(['NOSSO1']);
    await post(msg({ fromMe: true, messageId: 'NOSSO1', text: { message: 'resposta da Camila' } }));
    await espera(2000);
    assert.strictEqual(await conv.isPaused(WA_PACIENTE), false, 'eco próprio não pode pausar a IA');
    assert.strictEqual(await contar(WA_PACIENTE), 1, 'eco próprio não vira mensagem nova');

    // ── eco da Bruna numa conversa que a Camila atende: assume e pausa ─────────
    await post(msg({ fromMe: true, messageId: 'BRUNA1', text: { message: 'oi, aqui é a Bruna' } }));
    await espera(4000); // o handler espera 2s antes de concluir que não é eco nosso
    assert.strictEqual(await conv.isPaused(WA_PACIENTE), true, 'humana assumiu → IA pausada');
    assert.strictEqual(await contar(WA_PACIENTE), 2, 'a fala da Bruna entra no histórico');

    // ── eco da Bruna com quem NUNCA falou com a clínica: ignora por completo ───
    // Sem isto, cada mensagem pessoal dela criaria uma conversa pausada — e essa
    // pessoa, se um dia procurasse a clínica, nunca seria respondida.
    await post(msg({ phone: WA_PESSOAL, fromMe: true, messageId: 'PESSOAL1', text: { message: 'oi amiga' } }));
    await espera(4000);
    assert.strictEqual(await contar(WA_PESSOAL), 0, 'conversa pessoal não é gravada');
    assert.strictEqual(await conv.isPaused(WA_PESSOAL), false, 'e não deixa a IA muda pra esse número');

    console.log('test-webhook-http: todos os asserts passaram ✔');
  } finally {
    proc.kill();
    for (const wa of [WA_PACIENTE, WA_FORA, WA_PESSOAL]) await deletePatientData(wa);
    await query(`DELETE FROM wa_outbound WHERE wamid IN ('NOSSO1')`);
    await getPool().end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
