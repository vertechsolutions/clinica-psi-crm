/**
 * Testes das ESCRITAS no Postgres — a camada onde bug silencioso mora e que até
 * agora não tinha teste nenhum: dedup de mensagem, `wa_outbound` (o que impede a
 * Camila de se pausar sozinha ao ver o eco da própria resposta), merge da ficha,
 * pausa/retomada e a limpeza de retenção.
 *
 * Roda contra um Postgres DE TESTE, nunca o de produção — a checagem no começo
 * recusa qualquer URL que não venha de `TEST_DATABASE_URL`.
 *
 * Setup (uma vez): serviço Postgres separado no Railway com TCP proxy ligado, e
 *   TEST_DATABASE_URL=postgresql://...proxy.rlwy.net:PORTA/railway
 * no `.env.local`.
 *
 * Rodar:  npm run test:db
 */
import assert from 'node:assert';

const TEST_URL = process.env.TEST_DATABASE_URL?.trim();
if (!TEST_URL) {
  console.error(
    'TEST_DATABASE_URL ausente. Este teste ESCREVE e APAGA dados — precisa de um banco de teste.\n' +
      'No Railway: serviço Postgres separado → Settings → Networking → TCP Proxy,\n' +
      'depois copie a URL pública pro .env.local como TEST_DATABASE_URL.',
  );
  process.exit(1);
}
// Trava de segurança: o banco de produção do assistente é o serviço "Postgres"
// do mesmo projeto. Se alguém colar a URL errada aqui, o teste apaga conversa de
// paciente de verdade — então exige que a URL seja explicitamente a de teste.
if (process.env.DATABASE_URL && process.env.DATABASE_URL.trim() === TEST_URL) {
  console.error('TEST_DATABASE_URL é igual à DATABASE_URL. Recusando rodar contra o banco do app.');
  process.exit(1);
}
process.env.DATABASE_URL = TEST_URL;

/** números fictícios, fora de qualquer faixa real, pra não colidir com paciente */
const WA_A = '5500000000001';
const WA_B = '5500000000002';
const WA_C = '5500000000003';

async function main() {
  const { query, getPool } = await import('../src/lib/db');
  const { initSchema } = await import('../src/lib/schema');
  const conv = await import('../src/lib/conversation');
  const { cleanupExpired, deletePatientData } = await import('../src/lib/maintenance');

  // ── schema é idempotente (roda no boot de toda instância) ───────────────────
  await initSchema();
  await initSchema();
  const { rows: tabelas } = await query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_name IN ('wa_conversations','wa_messages','app_config','wa_outbound')`,
  );
  assert.strictEqual(tabelas.length, 4, 'as 4 tabelas existem (wa_outbound é a nova)');

  // estado limpo pros números de teste
  for (const wa of [WA_A, WA_B, WA_C]) await deletePatientData(wa);

  // ── dedup da mensagem do paciente: é o que impede resposta dobrada ──────────
  assert.strictEqual(await conv.recordUserMessage(WA_A, 'oi', 'MSG1'), true, 'primeira vez processa');
  assert.strictEqual(await conv.recordUserMessage(WA_A, 'oi', 'MSG1'), false, 'reentrega do mesmo id é ignorada');
  assert.strictEqual(await conv.recordUserMessage(WA_A, 'oi de novo', 'MSG2'), true, 'id diferente passa');

  // ── fala da clínica: com id deduplica; sem id nunca conflita ───────────────
  // (a resposta da Camila é gravada sem id porque o texto é a junção das bolhas;
  // vários NULL no UNIQUE são permitidos no Postgres — se não fossem, a segunda
  // resposta de qualquer conversa sumiria do histórico)
  assert.strictEqual(await conv.recordAssistantMessage(WA_A, 'resposta 1'), true);
  assert.strictEqual(await conv.recordAssistantMessage(WA_A, 'resposta 2'), true, 'sem wamid não colide');
  assert.strictEqual(await conv.recordAssistantMessage(WA_A, 'eco da Bruna', 'ECO1'), true);
  assert.strictEqual(await conv.recordAssistantMessage(WA_A, 'eco da Bruna', 'ECO1'), false, 'eco reentregue');

  // ── wa_outbound: distingue o eco da própria Camila do da Bruna ──────────────
  assert.strictEqual(await conv.foiNossoEnvio('DESCONHECIDO'), false, 'id que não enviamos');
  await conv.registrarEnvios([]); // no-op, não pode explodir
  await conv.registrarEnvios(['OUT1', 'OUT2']);
  await conv.registrarEnvios(['OUT1']); // repetido: ON CONFLICT
  assert.strictEqual(await conv.foiNossoEnvio('OUT1'), true, 'nosso envio é reconhecido');
  assert.strictEqual(await conv.foiNossoEnvio('OUT2'), true);

  // ── temHistorico: separa conversa de atendimento da vida pessoal da Bruna ───
  assert.strictEqual(await conv.temHistorico(WA_A), true, 'já trocou mensagem com a Camila');
  assert.strictEqual(await conv.temHistorico(WA_C), false, 'número que nunca falou com a clínica');

  // ── pausa e retomada ────────────────────────────────────────────────────────
  assert.strictEqual(await conv.isPaused(WA_A), false, 'começa despausada');
  await conv.pauseConversation(WA_A);
  assert.strictEqual(await conv.isPaused(WA_A), true);
  assert.strictEqual(await conv.resumeConversation(WA_A), true, 'admin devolve pra IA');
  assert.strictEqual(await conv.isPaused(WA_A), false);
  assert.strictEqual(await conv.resumeConversation(WA_C), false, 'número inexistente não vira sucesso');

  // pausa cria a linha quando a conversa ainda não existe (Bruna assume antes do
  // primeiro turno da IA) — um UPDATE puro não pausaria nada
  assert.strictEqual(await conv.isPaused(WA_B), false);
  await conv.pauseConversation(WA_B);
  assert.strictEqual(await conv.isPaused(WA_B), true, 'INSERT…ON CONFLICT criou a conversa pausada');

  // ── ficha: merge nunca apaga campo anterior ─────────────────────────────────
  // (foi um bug real: `lead = EXCLUDED.lead` no upsert apagava os outros 19 campos)
  await conv.upsertConversation(WA_A, 'Marina', { nome: 'Marina', motivacao: 'ansiedade' } as never, false);
  await conv.upsertConversation(WA_A, undefined, { disponibilidade: 'noite' } as never, true);
  const { rows: fichaRows } = await query<{ lead: Record<string, unknown>; pronto: boolean; nome: string }>(
    `SELECT lead, pronto, nome FROM wa_conversations WHERE wa_id = $1`,
    [WA_A],
  );
  const ficha = fichaRows[0];
  assert.strictEqual(ficha.lead.motivacao, 'ansiedade', 'campo do primeiro turno sobrevive');
  assert.strictEqual(ficha.lead.disponibilidade, 'noite', 'campo novo entra');
  assert.strictEqual(ficha.nome, 'Marina', 'nome não é apagado por um upsert sem nome');
  assert.strictEqual(ficha.pronto, true, 'pronto é monotônico (OR)');

  // ── retenção (LGPD) e limpeza da wa_outbound ────────────────────────────────
  await query(`UPDATE wa_conversations SET updated_at = now() - interval '200 days' WHERE wa_id = $1`, [WA_A]);
  await query(`UPDATE wa_outbound SET created_at = now() - interval '3 days' WHERE wamid = 'OUT1'`);
  const limpeza = await cleanupExpired();
  assert.ok(limpeza.conversas >= 1, 'conversa concluída além de 90 dias é apagada');
  assert.strictEqual(await conv.foiNossoEnvio('OUT1'), false, 'id de envio antigo é descartado');
  assert.strictEqual(await conv.foiNossoEnvio('OUT2'), true, 'id recente permanece');
  const { rows: sobrou } = await query(`SELECT 1 FROM wa_messages WHERE wa_id = $1`, [WA_A]);
  assert.strictEqual(sobrou.length, 0, 'as mensagens vão junto com a conversa');

  // ── direito ao apagamento ───────────────────────────────────────────────────
  await conv.recordUserMessage(WA_B, 'quero apagar meus dados', 'MSG3');
  const apagado = await deletePatientData(WA_B);
  assert.ok(apagado.mensagens >= 1 && apagado.conversas >= 1);
  assert.strictEqual(await conv.temHistorico(WA_B), false);

  // limpeza final: não deixa rastro dos números de teste
  for (const wa of [WA_A, WA_B, WA_C]) await deletePatientData(wa);
  await query(`DELETE FROM wa_outbound WHERE wamid IN ('OUT1','OUT2')`);
  await getPool().end();

  console.log('test-db-live: todos os asserts passaram ✔');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
