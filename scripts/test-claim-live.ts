/**
 * Testes do CLAIM DE TURNO contra Postgres de verdade — a trava que impede a
 * Camila de responder duas vezes (print de 06/08/2026, 17:59).
 *
 * Precisa de banco porque o que está sob teste NÃO é a função: é a semântica de
 * concorrência do `INSERT ... ON CONFLICT DO UPDATE ... WHERE` sob READ
 * COMMITTED. Um mock provaria só que o mock funciona.
 *
 * Roda contra um Postgres DE TESTE, nunca o de produção.
 *
 * Setup (uma vez), qualquer um dos dois:
 *   docker run -d --name camila-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
 *   TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres?sslmode=disable
 * ou um serviço Postgres separado no Railway com TCP Proxy (ver test-db-live.ts).
 *
 * Rodar:  npm run test:claim
 */
import assert from 'node:assert';

const TEST_URL = process.env.TEST_DATABASE_URL?.trim();
if (!TEST_URL) {
  console.error(
    'TEST_DATABASE_URL ausente. Este teste ESCREVE e APAGA dados — precisa de um banco de teste.\n' +
      'Local:   docker run -d --name camila-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16\n' +
      '         TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres?sslmode=disable\n' +
      'Railway: serviço Postgres separado → Settings → Networking → TCP Proxy.',
  );
  process.exit(1);
}
if (process.env.DATABASE_URL && process.env.DATABASE_URL.trim() === TEST_URL) {
  console.error('TEST_DATABASE_URL é igual à DATABASE_URL. Recusando rodar contra o banco do app.');
  process.exit(1);
}
process.env.DATABASE_URL = TEST_URL;

/** números fictícios, fora de qualquer faixa real, pra não colidir com paciente */
const WA_NOVO = '5500000000021'; // nunca teve linha em wa_conversations
const WA_EXISTENTE = '5500000000022'; // já é paciente conhecido
const WA_GUARDA = '5500000000023'; // o que prova que o claim não estraga a ficha

/** Quantas vezes repetir a corrida: uma passada só serializa por sorte. */
const RODADAS = 20;

async function main() {
  const { query, getPool } = await import('../src/lib/db');
  const { initSchema } = await import('../src/lib/schema');
  const { deletePatientData } = await import('../src/lib/maintenance');
  const conv = await import('../src/lib/conversation');
  const { claimTurno, releaseTurno, aindaTitular, podeFalar, TURNO_TTL_SEGUNDOS } = await import(
    '../src/lib/turno-claim'
  );

  const TODOS = [WA_NOVO, WA_EXISTENTE, WA_GUARDA];
  const limpar = async () => {
    for (const wa of TODOS) await deletePatientData(wa);
  };

  await initSchema();
  await limpar();

  // ── as colunas do claim existem (o initSchema é cumulativo) ─────────────────
  const { rows: colunas } = await query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'wa_conversations' AND column_name IN ('turno_ate','turno_token')`,
  );
  assert.strictEqual(colunas.length, 2, 'turno_ate e turno_token existem');

  // ── o caso do PRINT: número novo, sem linha em wa_conversations ─────────────
  // É o mais grave e o que um `UPDATE` puro jamais pegaria — a linha só nasceria
  // no persistReply, ou seja, DEPOIS de as duas respostas já terem saído.
  for (let i = 0; i < RODADAS; i++) {
    await deletePatientData(WA_NOVO);
    const [a, b] = await Promise.all([claimTurno(WA_NOVO), claimTurno(WA_NOVO)]);
    const vencedores = [a, b].filter(Boolean);
    assert.strictEqual(
      vencedores.length,
      1,
      `rodada ${i}: exatamente um claim vence em número NOVO (veio ${vencedores.length})`,
    );
  }

  // ── mesmo caso, com a conversa já existente ────────────────────────────────
  for (let i = 0; i < RODADAS; i++) {
    await deletePatientData(WA_EXISTENTE);
    // `as never` na ficha parcial é o padrão do repo pros testes (test-db-live.ts:101):
    // o upsert faz merge JSONB e aceita parcial, mas o tipo declara o lead inteiro.
    await conv.upsertConversation(WA_EXISTENTE, 'Zoraide', { nome: 'Zoraide' } as never, false);
    const [a, b] = await Promise.all([claimTurno(WA_EXISTENTE), claimTurno(WA_EXISTENTE)]);
    assert.strictEqual(
      [a, b].filter(Boolean).length,
      1,
      `rodada ${i}: exatamente um claim vence em conversa existente`,
    );
  }

  // ── um terceiro claim não passa por cima de um turno em andamento ──────────
  await deletePatientData(WA_NOVO);
  const token = await claimTurno(WA_NOVO);
  assert.ok(token, 'o primeiro claim de um número livre sempre passa');
  assert.strictEqual(await claimTurno(WA_NOVO), null, 'turno em andamento não é reivindicável');

  // ── release com o token ERRADO não libera ──────────────────────────────────
  // Sem esta regra, um turno pendurado além do TTL apagaria o claim de quem
  // assumiu depois — e as duas respostas sairiam, que é o bug original.
  await releaseTurno(WA_NOVO, 'token-de-outro-turno');
  assert.strictEqual(await claimTurno(WA_NOVO), null, 'token errado não libera o claim');

  // ── release com o token CERTO libera ──────────────────────────────────────
  await releaseTurno(WA_NOVO, token!);
  const token2 = await claimTurno(WA_NOVO);
  assert.ok(token2, 'depois do release certo, o próximo turno assume');

  // ── titularidade ─────────────────────────────────────────────────────────
  assert.strictEqual(await aindaTitular(WA_NOVO, token2!), true, 'o titular se reconhece');
  assert.strictEqual(
    await aindaTitular(WA_NOVO, token!),
    false,
    'o turno anterior sabe que perdeu a titularidade',
  );

  // ── claim expirado por TTL é reivindicável (processo que morreu no meio) ───
  await query(`UPDATE wa_conversations SET turno_ate = now() - interval '1 second' WHERE wa_id = $1`, [
    WA_NOVO,
  ]);
  const token3 = await claimTurno(WA_NOVO);
  assert.ok(token3, 'claim expirado é reivindicável');
  assert.notStrictEqual(token3, token2, 'e o token novo é outro');
  assert.strictEqual(
    await aindaTitular(WA_NOVO, token2!),
    false,
    'quem foi expirado E substituído perde a titularidade',
  );

  // ── decisão token-only: TTL vencido mas INCONTESTADO ainda é titular ───────
  // `aindaTitular` casa só pelo token de propósito. Se exigisse turno_ate > now(),
  // um turno lento (Gemini pendurado) abortaria o envio sem que ninguém tivesse
  // assumido — o lead ficaria sem resposta por precaução contra um risco que não
  // existia. A expiração governa quem ADQUIRE, não quem já tem.
  await query(`UPDATE wa_conversations SET turno_ate = now() - interval '1 second' WHERE wa_id = $1`, [
    WA_NOVO,
  ]);
  assert.strictEqual(
    await aindaTitular(WA_NOVO, token3!),
    true,
    'TTL vencido sem contestação NÃO tira a titularidade',
  );
  await releaseTurno(WA_NOVO, token3!);

  // ── o claim não pode encostar em NADA da ficha ────────────────────────────
  // updated_at é relógio de três coisas: o follow-up (leads frios), a retenção
  // LGPD do maintenance e a ordenação do painel. Se o claim o tocasse, o lead
  // nunca esfriaria e o dado de saúde ficaria guardado mais tempo — em silêncio.
  await deletePatientData(WA_GUARDA);
  await conv.upsertConversation(WA_GUARDA, 'Marina', { motivacao: 'ansiedade' } as never, true);
  await conv.pauseConversation(WA_GUARDA);
  const antes = await query<{
    nome: string;
    lead: Record<string, unknown>;
    pronto: boolean;
    pausada: boolean;
    updated_at: Date;
  }>(`SELECT nome, lead, pronto, pausada, updated_at FROM wa_conversations WHERE wa_id = $1`, [WA_GUARDA]);

  const tokenG = await claimTurno(WA_GUARDA);
  assert.ok(tokenG, 'claim funciona em conversa pausada (quem decide calar é o turno, não o claim)');

  const depois = await query<{
    nome: string;
    lead: Record<string, unknown>;
    pronto: boolean;
    pausada: boolean;
    updated_at: Date;
  }>(`SELECT nome, lead, pronto, pausada, updated_at FROM wa_conversations WHERE wa_id = $1`, [WA_GUARDA]);

  assert.strictEqual(
    depois.rows[0].updated_at.getTime(),
    antes.rows[0].updated_at.getTime(),
    'o claim NÃO move updated_at (follow-up + retenção LGPD + ordenação do painel)',
  );
  assert.strictEqual(depois.rows[0].nome, antes.rows[0].nome, 'o claim não mexe no nome');
  assert.deepStrictEqual(depois.rows[0].lead, antes.rows[0].lead, 'o claim não mexe na ficha');
  assert.strictEqual(depois.rows[0].pronto, antes.rows[0].pronto, 'o claim não mexe em pronto');
  assert.strictEqual(depois.rows[0].pausada, antes.rows[0].pausada, 'o claim não mexe em pausada');
  await releaseTurno(WA_GUARDA, tokenG!);

  // ── a linha "fantasma" de um número novo nasce inerte ─────────────────────
  // O claim cria a linha antes de o lead virar paciente. Ela precisa ficar FORA
  // do reengajamento (lead NULL não tem motivacao) e não pode nascer pausada.
  await deletePatientData(WA_NOVO);
  const tokenF = await claimTurno(WA_NOVO);
  const { rows: fantasma } = await query<{ lead: unknown; pausada: boolean; pronto: boolean }>(
    `SELECT lead, pausada, pronto FROM wa_conversations WHERE wa_id = $1`,
    [WA_NOVO],
  );
  assert.strictEqual(fantasma.length, 1, 'o claim criou a linha do número novo');
  assert.strictEqual(fantasma[0].lead, null, 'sem ficha — fica fora do findColdLeads');
  assert.strictEqual(fantasma[0].pausada, false, 'não nasce calada');
  assert.strictEqual(fantasma[0].pronto, false, 'não nasce pronta');
  await releaseTurno(WA_NOVO, tokenF!);

  // ── a Bruna assume o chat DURANTE o turno (print de 11/08/2026) ───────────
  // O claim continua válido — ninguém disputou o número. O que mudou foi a
  // conversa deixar de ser da IA. `aindaTitular` diz "sim" e é por isso que ele
  // sozinho não bastava: quem responde a pergunta certa é o `podeFalar`.
  await deletePatientData(WA_EXISTENTE);
  const tokenH = await claimTurno(WA_EXISTENTE);
  assert.ok(tokenH, 'pegou o claim pra simular o handoff');
  assert.strictEqual(await podeFalar(WA_EXISTENTE, tokenH!), 'ok', 'com a conversa ativa, o titular fala');

  await conv.pauseConversation(WA_EXISTENTE);
  assert.strictEqual(
    await aindaTitular(WA_EXISTENTE, tokenH!),
    true,
    'a pausa NÃO tira a titularidade — é exatamente por isso que o aindaTitular deixava passar',
  );
  assert.strictEqual(
    await podeFalar(WA_EXISTENTE, tokenH!),
    'pausada',
    'a equipe assumiu durante o turno: nenhuma bolha sai (o print de 11/08/2026)',
  );

  await conv.resumeConversation(WA_EXISTENTE);
  assert.strictEqual(
    await podeFalar(WA_EXISTENTE, tokenH!),
    'ok',
    'devolvida pra IA, o mesmo turno volta a poder falar',
  );
  assert.strictEqual(
    await podeFalar(WA_EXISTENTE, 'token-de-outro-turno'),
    'sem-titularidade',
    'e o portão novo continua barrando quem não é titular',
  );
  await releaseTurno(WA_EXISTENTE, tokenH!);

  // ── o TTL é teto de segurança, e o retry do turno é calibrado contra ele ───
  assert.ok(TURNO_TTL_SEGUNDOS > 0 && TURNO_TTL_SEGUNDOS <= 300, 'TTL num intervalo sensato');

  await limpar();
  await getPool().end();

  console.log('test-claim-live: todos os asserts passaram ✔');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
