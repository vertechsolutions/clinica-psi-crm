/**
 * Testes da VARREDURA DE PENDENTES contra Postgres de verdade — a rede que
 * responde quem ficou falando sozinho quando o processo morreu dentro da janela
 * de 8s do debounce.
 *
 * Precisa de banco porque o que está sob teste é a CONSULTA: quem é "conversa
 * pendente" sai de um `GROUP BY ... HAVING` com `FILTER` e `LEFT JOIN`, e um
 * mock provaria só que o mock funciona. O que ela decide é quem a Camila vai
 * abordar sozinha na subida do app — errar aqui é falar por cima de uma
 * conversa humana em andamento da Bruna.
 *
 * NÃO chama o Gemini: a varredura aceita um espião no lugar do
 * `processarTurnoPendente`, porque o que precisa de prova é o GATE (allowlist,
 * legado, pausa, janela de 30 min), não o ciclo do turno — esse já é coberto
 * pelo `test-turno-concorrencia`.
 *
 * Roda contra um Postgres DE TESTE, nunca o de produção (ver test-db-live.ts).
 *
 * Rodar:  npm run test:sweep
 */
import assert from 'node:assert';

const TEST_URL = process.env.TEST_DATABASE_URL?.trim();
if (!TEST_URL) {
  console.error('TEST_DATABASE_URL ausente — ver instruções em scripts/test-db-live.ts.');
  process.exit(1);
}
if (process.env.DATABASE_URL && process.env.DATABASE_URL.trim() === TEST_URL) {
  console.error('TEST_DATABASE_URL é igual à DATABASE_URL. Recusando rodar contra o banco do app.');
  process.exit(1);
}
process.env.DATABASE_URL = TEST_URL;
// A chave do legado é lida no IMPORT do módulo — precisa estar de pé antes dos
// `await import` lá embaixo, senão os hashes que este teste grava não casariam
// com os que o gate consulta.
process.env.WA_LEGADO_CHAVE = 'chave-de-teste-da-varredura';

/** números fictícios, fora de qualquer faixa real, pra não colidir com paciente */
const WA_PENDENTE = '5500000000031'; // paciente conhecido que escreveu e não foi respondido
const WA_NOVO = '5500000000032'; // primeiro contato, SEM linha em wa_conversations
const WA_RESPONDIDO = '5500000000033'; // a Camila já respondeu a última mensagem
const WA_PAUSADA = '5500000000034'; // handoff feito: a conversa é da equipe
const WA_LEGADO = '5500000000035'; // conversa que já era da Bruna antes da Camila
const WA_ANTIGO = '5500000000036'; // escreveu há 45 min: tarde demais pra responder
const WA_FORA = '5500000000037'; // fora da WA_ALLOWLIST da estreia

const TODOS = [WA_PENDENTE, WA_NOVO, WA_RESPONDIDO, WA_PAUSADA, WA_LEGADO, WA_ANTIGO, WA_FORA];

/**
 * A allowlist da estreia, com todo mundo MENOS o WA_FORA. Sem ela, o lixo que
 * outras suítes deixam no banco de teste entraria na varredura e o resultado
 * dependeria de quem rodou por último.
 *
 * Vazia não serve: com `WA_ALLOWLIST` vazia e nenhum snapshot de legado
 * importado, o gate cala TODO MUNDO ('sem-snapshot') e o teste passaria por
 * engano, provando o oposto do que quer provar.
 */
const ALLOWLIST_PADRAO = [WA_PENDENTE, WA_NOVO, WA_RESPONDIDO, WA_PAUSADA, WA_LEGADO, WA_ANTIGO];

async function main() {
  const { query, getPool } = await import('../src/lib/db');
  const { initSchema } = await import('../src/lib/schema');
  const { deletePatientData } = await import('../src/lib/maintenance');
  const { upsertConversation, pauseConversation } = await import('../src/lib/conversation');
  const { marcarLegadoEmLote, removerLegado, __resetCacheLegado } = await import('../src/lib/legado');
  const { varrerPendentes } = await import('../src/lib/boot-sweep');

  /** Grava uma mensagem com a idade que o cenário precisa. */
  const msg = async (waId: string, role: 'user' | 'assistant', minutosAtras: number) =>
    query(
      `INSERT INTO wa_messages (wa_id, role, content, wamid, created_at)
       VALUES ($1, $2, $3, $4, now() - ($5 || ' minutes')::interval)`,
      [waId, role, `[teste-varredura ${role}]`, `sweep-${waId}-${role}-${minutosAtras}`, String(minutosAtras)],
    );

  const limpar = async () => {
    for (const wa of TODOS) await deletePatientData(wa);
    await removerLegado(WA_LEGADO);
    __resetCacheLegado();
  };

  /**
   * Roda a varredura com um espião no lugar do turno e devolve só os NOSSOS
   * números, na ordem em que foram atendidos. O filtro é contra o lixo das
   * outras suítes: elas não podem fazer este teste falhar, e a allowlist já
   * garante que a varredura não encoste nelas.
   */
  const varrerComEspiao = async (falhar = false) => {
    const vistos: Array<{ waId: string; nome?: string }> = [];
    const n = await varrerPendentes(async (waId, nome) => {
      vistos.push({ waId, nome });
      if (falhar) throw new Error('turno explodiu de propósito');
    });
    return { vistos: vistos.filter((v) => TODOS.includes(v.waId)), n };
  };

  await initSchema();
  await limpar();

  // ── o cenário ──────────────────────────────────────────────────────────────
  // Idades escolhidas na casa dos 20 min de propósito: a varredura atende do
  // mais antigo para o mais novo e tem teto por rodada, então mensagens velhas
  // garantem que o lixo recente de outra suíte não empurre as nossas pra fora.
  await upsertConversation(WA_PENDENTE, 'Zoraide', { nome: 'Zoraide' } as never, false);
  await msg(WA_PENDENTE, 'assistant', 26);
  await msg(WA_PENDENTE, 'user', 20);

  // o caso mais grave: morreu antes da PRIMEIRA resposta, então não existe linha
  // em wa_conversations. Partir das conversas em vez das mensagens perderia ele.
  await msg(WA_NOVO, 'user', 25);

  await upsertConversation(WA_RESPONDIDO, 'Marina', { nome: 'Marina' } as never, false);
  await msg(WA_RESPONDIDO, 'user', 24);
  await msg(WA_RESPONDIDO, 'assistant', 20);

  await upsertConversation(WA_PAUSADA, 'Helena', { nome: 'Helena' } as never, true);
  await pauseConversation(WA_PAUSADA);
  await msg(WA_PAUSADA, 'user', 22);

  await marcarLegadoEmLote([WA_LEGADO], 'manual');
  await msg(WA_LEGADO, 'user', 23);

  await msg(WA_ANTIGO, 'user', 45);
  await msg(WA_FORA, 'user', 21);

  process.env.WA_ALLOWLIST = ALLOWLIST_PADRAO.join(',');

  // ── quem a varredura acha, e em que ordem ─────────────────────────────────
  const { vistos, n } = await varrerComEspiao();
  const achados = vistos.map((v) => v.waId);

  assert.deepStrictEqual(
    achados,
    [WA_NOVO, WA_PENDENTE],
    'a varredura acha o lead novo e o paciente sem resposta, do mais antigo para o mais novo\n' +
      '  (se veio vazio: o gate do legado pode estar calando tudo — confira app_config.legado_chave_fp no banco de teste)',
  );
  assert.strictEqual(n >= 2, true, 'o retorno conta as conversas mandadas reprocessar');
  assert.strictEqual(
    vistos.find((v) => v.waId === WA_PENDENTE)?.nome,
    'Zoraide',
    'o nome da ficha viaja junto (é o que o turno usa quando o histórico ainda é curto)',
  );
  assert.strictEqual(
    vistos.find((v) => v.waId === WA_NOVO)?.nome,
    undefined,
    'lead sem ficha vai sem nome, não com null',
  );

  // os quatro que ela NÃO pode tocar — cada um por um motivo diferente
  assert.ok(!achados.includes(WA_RESPONDIDO), 'conversa já respondida fica de fora');
  assert.ok(!achados.includes(WA_PAUSADA), 'conversa pausada (handoff) fica de fora');
  assert.ok(!achados.includes(WA_LEGADO), 'número da lista de legado fica de fora');
  assert.ok(!achados.includes(WA_ANTIGO), 'mensagem com mais de 30 min fica de fora');
  assert.ok(!achados.includes(WA_FORA), 'número fora da allowlist fica de fora');

  // ── e os motivos são MESMO esses (senão o teste passaria por acidente) ────
  // Tirar só a causa e ver o número aparecer é o que distingue "o gate barrou"
  // de "a consulta nunca o enxergou".
  process.env.WA_ALLOWLIST = [...ALLOWLIST_PADRAO, WA_FORA].join(',');
  const naAllowlist = (await varrerComEspiao()).vistos.map((v) => v.waId);
  assert.ok(
    naAllowlist.includes(WA_FORA),
    'o que barrava o WA_FORA era a allowlist — dentro dela, a varredura o atende',
  );
  process.env.WA_ALLOWLIST = ALLOWLIST_PADRAO.join(',');

  await removerLegado(WA_LEGADO);
  __resetCacheLegado();
  const semLegado = (await varrerComEspiao()).vistos.map((v) => v.waId);
  assert.ok(
    semLegado.includes(WA_LEGADO),
    'o que barrava o WA_LEGADO era a lista de conversas antigas da Bruna',
  );
  await marcarLegadoEmLote([WA_LEGADO], 'manual');
  __resetCacheLegado();

  // ── claim preso do processo anterior não pode emudecer o número ───────────
  // Um turno que morreu no meio deixa turno_ate no futuro; sem soltá-lo, a
  // varredura desistiria em silêncio e o lead esperaria o TTL de 90s — só que
  // ninguém varre de novo antes do próximo boot.
  await query(
    `UPDATE wa_conversations
        SET turno_ate = now() + interval '60 seconds', turno_token = 'token-do-processo-morto'
      WHERE wa_id = $1`,
    [WA_PENDENTE],
  );
  const comClaimPreso = (await varrerComEspiao()).vistos.map((v) => v.waId);
  assert.ok(comClaimPreso.includes(WA_PENDENTE), 'claim preso do processo anterior é liberado no boot');
  const { rows: claim } = await query<{ turno_ate: Date | null; turno_token: string | null }>(
    `SELECT turno_ate, turno_token FROM wa_conversations WHERE wa_id = $1`,
    [WA_PENDENTE],
  );
  assert.strictEqual(claim[0].turno_ate, null, 'o claim antigo foi zerado');
  assert.strictEqual(claim[0].turno_token, null, 'e o token junto');

  // ── nunca lança para fora ────────────────────────────────────────────────
  // É chamada fire-and-forget no boot: uma promise rejeitada sem handler derruba
  // o processo no Node moderno. Um número que explode não pode nem parar a fila
  // nem tirar o app do ar.
  const explosivo = await varrerComEspiao(true);
  assert.strictEqual(explosivo.n, 0, 'turno que explode não é contado como reprocessado');
  assert.strictEqual(
    explosivo.vistos.length,
    2,
    'e o erro de um número não interrompe a fila dos outros',
  );

  // ── conversa respondida no meio da fila não é reprocessada ───────────────
  // A fila é sequencial e cada turno leva dezenas de segundos: quando chega a
  // vez do último, o webhook ao vivo pode já ter atendido. Responder de novo
  // aqui seria a segunda bolha que esta leva inteira existe para matar.
  const respondidosNoMeio: string[] = [];
  await varrerPendentes(async (waId) => {
    if (!TODOS.includes(waId)) return;
    respondidosNoMeio.push(waId);
    // simula o webhook respondendo o PRÓXIMO da fila enquanto este roda
    if (waId === WA_NOVO) await msg(WA_PENDENTE, 'assistant', 0);
  });
  assert.deepStrictEqual(
    respondidosNoMeio,
    [WA_NOVO],
    'quem foi respondido enquanto a fila andava é pulado na reconferência',
  );

  await limpar();
  await getPool().end();

  console.log('test-sweep-live: todos os asserts passaram ✔');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
