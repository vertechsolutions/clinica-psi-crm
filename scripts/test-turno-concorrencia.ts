/**
 * Teste de CONCORRÊNCIA do turno — o único lugar do repo onde o bug do print de
 * 06/08/2026 é reproduzido do jeito que ele acontece: duas requisições HTTP de
 * verdade, no mesmo número, no mesmo instante.
 *
 * O `test-turno-agenda` prova a máquina de estados com relógio falso e o
 * `test-claim-live` prova a serialização no Postgres. Nenhum dos dois passa pelo
 * `route.ts`, que é justamente a peça que ligou tudo — e era ela que respondia
 * POR MENSAGEM. Aqui o app sobe inteiro e a rajada entra por `POST /api/whatsapp/webhook`.
 *
 * Sobe também um servidor HTTP falso no lugar da Z-API (`ZAPI_BASE_URL`), que é
 * como se conta "a Camila enviou UMA vez": cada bolha vira uma linha na lista de
 * envios, e nada sai para a rede. Sem esse stub o teste teria que confiar no
 * banco para julgar o que o paciente recebeu — e o banco só sabe do que já foi
 * persistido.
 *
 * Roda contra o Postgres DE TESTE (`TEST_DATABASE_URL`), nunca o de produção.
 *
 * CUSTA GEMINI DE VERDADE (3 turnos) e por isso é opt-in, fora do `npm test`: o
 * critério "a resposta contempla as duas mensagens" só existe se houver modelo
 * do outro lado. `DEBOUNCE_MS=500` no processo filho para não pagar 8s de
 * silêncio por cenário.
 *
 * Rodar:  npm run test:turno
 */
import assert from 'node:assert';
import http from 'node:http';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

const TEST_URL = process.env.TEST_DATABASE_URL?.trim();
if (!TEST_URL) {
  console.error('TEST_DATABASE_URL ausente — ver instruções em scripts/test-db-live.ts.');
  process.exit(1);
}
if (process.env.DATABASE_URL && process.env.DATABASE_URL.trim() === TEST_URL) {
  console.error('TEST_DATABASE_URL é igual à DATABASE_URL. Recusando rodar contra o banco do app.');
  process.exit(1);
}
if (!process.env.GEMINI_API_KEY?.trim()) {
  console.error(
    'GEMINI_API_KEY ausente. Este teste responde com o modelo de verdade — sem chave, o que ele\n' +
      'provaria é que o erro do Gemini não duplica, que não é o critério. Rode com --env-file=.env.local.',
  );
  process.exit(1);
}

const PORTA = 3989;
const PORTA_ZAPI = 3990;
const SEGREDO = 'segredo-de-teste-do-turno';
const BASE = `http://127.0.0.1:${PORTA}`;
const CHAVE_LEGADO = 'chave-de-teste-do-turno';

/** números fictícios, fora de qualquer faixa real, pra não colidir com paciente */
const WA_RAJADA = '5500000000031'; // duas mensagens no mesmo instante
const WA_MEIO = '5500000000032'; // mensagem que chega com o turno rodando
const WA_ROUBO = '5500000000033'; // turno que perde a titularidade no meio
const WA_ASSUMIDO = '5500000000038'; // a Bruna assume o chat com o turno rodando

/** o que o lead manda na rajada — cada fato está numa mensagem SÓ (ver CA2) */
const RAJADA_1 = 'oi, boa tarde! meu nome é Zoraide Antunes';
const RAJADA_2 = 'queria marcar uma consulta. meu e-mail é zoraide.antunes@exemplo.com';

// ───────────────────────────── Z-API de mentira ─────────────────────────────

interface Envio {
  phone: string;
  message: string;
}

const envios: Envio[] = [];
let leituras = 0;
/** caminho que o stub não esperava — vira erro de teste em vez de passar batido */
const inesperados: string[] = [];

/**
 * Responde o que o `zapi.ts` espera de cada endpoint. Sempre 200: o `zapiPost`
 * lança em resposta não-ok, e um erro aqui viraria "o turno falhou" em vez do
 * que o teste quer medir.
 */
function criarZapiFalsa(): Promise<http.Server> {
  const srv = http.createServer((req, res) => {
    let corpo = '';
    req.on('data', (c) => (corpo += c));
    req.on('end', () => {
      const caminho = (req.url || '').split('?')[0];
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(corpo || '{}') as Record<string, unknown>;
      } catch {
        /* endpoint sem corpo */
      }
      const responder = (j: unknown) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(j));
      };
      if (caminho.endsWith('/send-text')) {
        envios.push({ phone: String(payload.phone ?? ''), message: String(payload.message ?? '') });
        return responder({ messageId: `FAKE-${envios.length}` });
      }
      if (caminho.endsWith('/read-message')) {
        leituras++;
        return responder({});
      }
      inesperados.push(caminho);
      responder({});
    });
  });
  return new Promise((resolve) => srv.listen(PORTA_ZAPI, '127.0.0.1', () => resolve(srv)));
}

const enviosDe = (waId: string) => envios.filter((e) => e.phone === waId);

// ─────────────────────────────── o app real ─────────────────────────────────

const env = {
  ...process.env,
  DATABASE_URL: TEST_URL,
  // o motivo de o `debounceMs()` ler a env a cada chamada: 8s por cenário seria
  // meio minuto de teste esperando silêncio.
  DEBOUNCE_MS: '500',
  WA_PROVIDER: 'zapi',
  ZAPI_WEBHOOK_SECRET: SEGREDO,
  ZAPI_INSTANCE_ID: 'INSTTURNO',
  ZAPI_INSTANCE_TOKEN: 'TOKTURNO',
  ZAPI_CLIENT_TOKEN: '',
  ZAPI_BASE_URL: `http://127.0.0.1:${PORTA_ZAPI}`,
  WA_ALLOWLIST: `${WA_RAJADA},${WA_MEIO},${WA_ROUBO},${WA_ASSUMIDO}`,
  // sem destinatário de alerta: o handoff não sai da rede do teste, e o contador
  // de envios não mistura bolha de paciente com aviso interno.
  NOTIFY_ALERT_NUMBERS: '',
  WA_LEGADO_CHAVE: CHAVE_LEGADO,
  FORM_URL: 'https://exemplo.invalido/formulario',
  // a agenda real é Google Sheets: uma dependência de rede que não tem nada a
  // ver com o que está sob teste (e o `agendaContexto` já trata a ausência).
  AGENDA_SHEET_ID: '',
  GOOGLE_SERVICE_ACCOUNT_JSON: '',
  NODE_ENV: 'development' as const,
  PORT: String(PORTA),
};

/**
 * O log do servidor, capturado. É o único sinal externo de que um turno que
 * PERDEU a titularidade chegou ao fim — ele não escreve no banco nem envia nada,
 * que é justamente o ponto do CA7.
 */
const saida: string[] = [];
const MAX_LINHAS_LOG = 4000;

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

const post = (body: unknown) =>
  fetch(`${BASE}/api/whatsapp/webhook?s=${SEGREDO}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const msg = (over: Record<string, unknown>) => ({
  messageId: 'X1',
  momment: 1754300000000,
  isGroup: false,
  type: 'ReceivedCallback',
  text: { message: 'oi' },
  ...over,
});

async function subirServidor(): Promise<ChildProcess> {
  const proc = spawn('npx', ['next', 'dev', '-p', String(PORTA)], {
    env,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const guardar = (b: Buffer) => {
    for (const linha of b.toString().split('\n')) {
      if (linha.trim()) saida.push(linha);
    }
    if (saida.length > MAX_LINHAS_LOG) saida.splice(0, saida.length - MAX_LINHAS_LOG);
  };
  proc.stdout?.on('data', guardar);
  // console.warn vai pra stderr — e é lá que mora o aviso de titularidade perdida
  proc.stderr?.on('data', guardar);

  for (let i = 0; i < 60; i++) {
    await espera(1000);
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return proc;
    } catch {
      /* ainda subindo */
    }
  }
  matar(proc);
  throw new Error(`o servidor não subiu em 60s. Últimas linhas:\n${saida.slice(-30).join('\n')}`);
}

/**
 * `proc.kill()` sozinho não serve no Windows: com `shell: true` quem morre é o
 * `cmd.exe`, e o `next dev` neto fica vivo segurando a porta — a próxima rodada
 * do teste falharia sem explicação.
 */
function matar(proc: ChildProcess): void {
  if (process.platform === 'win32' && proc.pid) {
    spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  proc.kill();
}

const logTem = (re: RegExp) => saida.some((l) => re.test(l));

async function esperarAte(cond: () => boolean, rotulo: string, timeoutMs = 90_000): Promise<void> {
  const limite = Date.now() + timeoutMs;
  while (Date.now() < limite) {
    if (cond()) return;
    await espera(250);
  }
  throw new Error(`timeout esperando: ${rotulo}`);
}

const esperarLog = (re: RegExp, rotulo: string, timeoutMs = 90_000) =>
  esperarAte(() => logTem(re), `${rotulo} (${re})`, timeoutMs);

// ─────────────────────────────── helpers ────────────────────────────────────

/**
 * Duas bolhas de um mesmo turno viram uma string só, do mesmo jeito nos dois
 * lados da comparação: o `sendTextSequence` envia cada parte já trimada e o
 * `persistReply` grava o `join('\n\n')` das mesmas partes. Normalizar os dois é
 * o que deixa o assert falar de CONTEÚDO em vez de espaço em branco.
 */
const normalizar = (s: string) =>
  s
    .split(/\n{2,}/)
    .map((t) => t.trim())
    .filter(Boolean)
    .join('\n\n');

async function main() {
  process.env.DATABASE_URL = TEST_URL;
  process.env.WA_LEGADO_CHAVE = CHAVE_LEGADO;
  const { query, getPool } = await import('../src/lib/db');
  const { initSchema } = await import('../src/lib/schema');
  const legado = await import('../src/lib/legado');
  const { deletePatientData } = await import('../src/lib/maintenance');
  const conv = await import('../src/lib/conversation');

  const TODOS = [WA_RAJADA, WA_MEIO, WA_ROUBO, WA_ASSUMIDO];
  const limpar = async () => {
    for (const wa of TODOS) {
      await deletePatientData(wa);
      await legado.removerLegado(wa);
    }
    await query(`DELETE FROM wa_outbound WHERE wamid LIKE 'FAKE-%'`);
  };

  await initSchema();
  await limpar();
  // Estado de legado que outra suíte tenha deixado no banco de teste caleria a
  // Camila aqui por 'chave-divergente' — e o teste falharia acusando o debounce.
  await query(`DELETE FROM app_config WHERE key LIKE 'legado_%' OR key = 'camila_muda'`);

  interface Linha {
    id: string;
    role: string;
    content: string;
  }
  const mensagens = async (waId: string, role?: string): Promise<Linha[]> => {
    const { rows } = await query<Linha>(
      `SELECT id::text, role, content FROM wa_messages
        WHERE wa_id = $1 ${role ? 'AND role = $2' : ''} ORDER BY id`,
      role ? [waId, role] : [waId],
    );
    return rows;
  };

  /** null = ninguém está com o turno deste número agora. */
  const tokenDe = async (waId: string): Promise<string | null> => {
    const { rows } = await query<{ turno_token: string | null }>(
      `SELECT turno_token FROM wa_conversations WHERE wa_id = $1`,
      [waId],
    );
    return rows[0]?.turno_token ?? null;
  };

  const fichaDe = async (waId: string): Promise<Record<string, unknown> | null> => {
    const { rows } = await query<{ lead: Record<string, unknown> | null }>(
      `SELECT lead FROM wa_conversations WHERE wa_id = $1`,
      [waId],
    );
    return rows[0]?.lead ?? null;
  };

  /** Espera até o número estar com o claim: é o instante em que o turno começou. */
  async function esperarTurnoRodando(waId: string, timeoutMs = 30_000): Promise<string> {
    const limite = Date.now() + timeoutMs;
    while (Date.now() < limite) {
      const t = await tokenDe(waId);
      if (t) return t;
      await espera(50);
    }
    throw new Error(`timeout: o turno de ${waId} não chegou a assumir o claim`);
  }

  /**
   * Quietude: nada enviado, nada persistido e NINGUÉM com o claim por
   * `quietoMs` seguidos. É o "acabou" honesto — um segundo turno duplicado
   * precisaria reivindicar o claim e gastar dezenas de segundos no Gemini, e
   * qualquer um dos dois movimentos reinicia a contagem.
   */
  async function esperarSossego(waId: string, quietoMs = 6_000, timeoutMs = 150_000): Promise<void> {
    const limite = Date.now() + timeoutMs;
    let ultimoEvento = Date.now();
    let nEnvios = -1;
    let nMsgs = -1;
    while (Date.now() < limite) {
      const envs = enviosDe(waId).length;
      const msgs = (await mensagens(waId)).length;
      const token = await tokenDe(waId);
      if (envs !== nEnvios || msgs !== nMsgs || token !== null) {
        nEnvios = envs;
        nMsgs = msgs;
        ultimoEvento = Date.now();
      }
      if (Date.now() - ultimoEvento >= quietoMs) return;
      await espera(250);
    }
    throw new Error(`timeout esperando ${waId} sossegar (envios=${nEnvios}, mensagens=${nMsgs})`);
  }

  /**
   * A invariante que mata o print: TUDO que saiu para o paciente é exatamente o
   * que ficou no histórico como resposta da Camila, na mesma ordem. Uma bolha
   * repetida quebra dos dois lados — se foi enviada duas vezes e persistida uma,
   * as strings divergem; se foram dois turnos, o número de respostas denuncia.
   */
  const conferirEnvios = async (waId: string, quantasRespostas: number) => {
    const respostas = await mensagens(waId, 'assistant');
    assert.strictEqual(
      respostas.length,
      quantasRespostas,
      `${waId}: esperava ${quantasRespostas} resposta(s) da Camila, veio ${respostas.length}`,
    );
    assert.strictEqual(
      normalizar(enviosDe(waId).map((e) => e.message).join('\n\n')),
      normalizar(respostas.map((r) => r.content).join('\n\n')),
      'nenhuma bolha saiu além das respostas persistidas (e nenhuma resposta ficou sem sair)',
    );
  };

  console.log('subindo a Z-API falsa e o app...');
  const zapi = await criarZapiFalsa();
  const proc = await subirServidor();
  try {
    // O log do servidor é o sinal do CA7. Se ele não estiver chegando aqui, o
    // cenário 3 daria timeout sem dizer por quê — melhor descobrir agora.
    await esperarLog(/\[boot\] schema Postgres pronto/, 'boot do schema', 30_000);

    // Aquece a rota: em `next dev` a primeira requisição paga a compilação, e
    // uma rajada cujo primeiro POST espera o compilador não é uma rajada.
    await post({ type: 'DeliveryCallback', phone: WA_RAJADA, messageId: 'D0', zaapId: 'Z0', status: 'SENT' });
    await espera(2000);

    // ── CA1 + CA2: duas mensagens ao mesmo tempo viram UM turno ──────────────
    // O print de 06/08/2026, reproduzido: dois `after()` concorrentes no mesmo
    // wa_id. Antes do debounce cada um lia o histórico antes de o outro
    // persistir, e o lead recebia o mesmo par de bolhas duas vezes.
    {
      const [r1, r2] = await Promise.all([
        post(msg({ phone: WA_RAJADA, messageId: 'RAJ1', text: { message: RAJADA_1 } })),
        post(msg({ phone: WA_RAJADA, messageId: 'RAJ2', text: { message: RAJADA_2 } })),
      ]);
      assert.strictEqual(r1.status, 200, 'o webhook responde 200 na hora (a Z-API reenvia se demorar)');
      assert.strictEqual(r2.status, 200);

      await esperarSossego(WA_RAJADA);

      // UMA resposta persistida = UM turno respondido = UMA chamada ao Gemini.
      // É o sinal que importa pro lead, e o único que não exige instrumentar o
      // código de produção só para o teste enxergar.
      await conferirEnvios(WA_RAJADA, 1);
      assert.ok(enviosDe(WA_RAJADA).length >= 1, 'e a resposta chegou a sair');

      const usuarias = await mensagens(WA_RAJADA, 'user');
      const respostas = await mensagens(WA_RAJADA, 'assistant');
      assert.strictEqual(usuarias.length, 2, 'as duas mensagens do lead entraram no histórico');
      assert.ok(
        usuarias.every((u) => BigInt(u.id) < BigInt(respostas[0].id)),
        'as duas estavam gravadas ANTES da resposta: é isso que faz o turno enxergar a rajada inteira',
      );

      // CA2, o lado que só o modelo pode provar: cada mensagem trouxe UM fato, e
      // os dois precisam aparecer na ficha extraída pelo turno único. O assert é
      // na ficha e não no texto da resposta de propósito — a redação da Camila
      // varia a cada chamada, o campo extraído de um dado dito com todas as
      // letras não.
      const ficha = await fichaDe(WA_RAJADA);
      assert.match(
        String(ficha?.nome ?? ''),
        /zoraide/i,
        'o nome veio da PRIMEIRA mensagem da rajada — sem ele, o turno só leu a última',
      );
      assert.match(
        String(ficha?.email ?? ''),
        /zoraide\.antunes@exemplo\.com/i,
        'e o e-mail veio da SEGUNDA — o turno contemplou o conteúdo das duas',
      );
    }

    // ── CA6: mensagem que chega COM o turno rodando é respondida depois ──────
    // Ela não pode entrar no turno que já começou (o histórico dele já foi lido)
    // nem sumir: abre uma janela nova, perde o claim, e a agenda insiste.
    {
      await post(msg({ phone: WA_MEIO, messageId: 'MEIO1', text: { message: 'oi, queria marcar uma consulta' } }));
      await esperarTurnoRodando(WA_MEIO);
      // daqui em diante o pendente já saiu do buffer: o que chegar abre janela nova
      const r = await post(
        msg({ phone: WA_MEIO, messageId: 'MEIO2', text: { message: 'esqueci de dizer: só consigo de manhã' } }),
      );
      assert.strictEqual(r.status, 200);

      await esperarSossego(WA_MEIO);
      await conferirEnvios(WA_MEIO, 2);
      const usuarias = await mensagens(WA_MEIO, 'user');
      assert.strictEqual(usuarias.length, 2, 'a mensagem do meio do turno foi gravada');
      // duas respostas = a segunda mensagem teve turno próprio. Uma só significaria
      // que ela foi engolida — o lead falando sozinho, que é pior que responder duas
      // vezes porque ninguém percebe.
    }

    // ── CA7: turno que perde a titularidade no meio NÃO envia ────────────────
    // A reconferência acontece imediatamente antes do primeiro byte que sai. Sem
    // ela, um turno que passou do TTL enquanto o Gemini pensava entregaria o
    // mesmo par de bolhas por cima de quem assumiu — o print outra vez.
    //
    // O roubo é por fora, direto na linha: é o que um SEGUNDO processo (deploy
    // sobreposto, varredura de boot) faz quando o claim expira, e o teste não
    // tem como forçar a expiração de 90s sem esperar 90s.
    {
      await post(msg({ phone: WA_ROUBO, messageId: 'ROUBO1', text: { message: 'oi, tudo bem?' } }));
      const token = await esperarTurnoRodando(WA_ROUBO);
      const roubado = await query(
        `UPDATE wa_conversations
            SET turno_token = 'ladrao-do-teste', turno_ate = now() + interval '90 seconds'
          WHERE wa_id = $1 AND turno_token = $2`,
        [WA_ROUBO, token],
      );
      assert.strictEqual(roubado.rowCount, 1, 'o roubo do claim precisa acontecer com o turno ainda rodando');

      // Os dois caminhos que reconferem a titularidade logam "perdida": o do
      // envio abortado e o do aviso de instabilidade suprimido. Qualquer um dos
      // dois é o CA7 acontecendo — em nenhum sai bolha.
      //
      // A bolha entra na condição de parada junto com o log de propósito: sem a
      // reconferência o log nunca vem, e esperar só por ele transformaria "a
      // Camila escreveu por cima de quem assumiu" num timeout de 90s que não diz
      // o que quebrou. Assim a corrida termina no primeiro dos dois e o assert
      // abaixo mostra o que foi enviado.
      await esperarAte(
        () => logTem(/titularidade.*perdida/i) || enviosDe(WA_ROUBO).length > 0,
        'o turno perceber que perdeu a vez (ou mandar bolha por cima de quem assumiu)',
      );
      await espera(3000); // se fosse enviar mesmo assim, seria agora

      assert.deepStrictEqual(enviosDe(WA_ROUBO), [], 'turno sem titularidade não manda NADA para o paciente');
      await conferirEnvios(WA_ROUBO, 0);
      assert.ok(
        !logTem(new RegExp(`\\+${WA_ROUBO}`)),
        'e o número não aparece inteiro no log (LGPD)',
      );

      // devolve a linha ao estado livre pra limpeza não brigar com o claim falso
      await query(`UPDATE wa_conversations SET turno_ate = NULL, turno_token = NULL WHERE wa_id = $1`, [
        WA_ROUBO,
      ]);
    }

    // ── CA8: a BRUNA assume o chat com o turno rodando ───────────────────────
    // O print de 11/08/2026, ponta a ponta. A conversa não perde a titularidade
    // (ninguém disputou o número) — perde a VOZ, porque deixou de ser da IA. Sem
    // o `podeFalar`, o `aindaTitular` diria "sim, o claim é seu" e a Camila
    // escreveria por cima da psicóloga.
    //
    // A pausa é gravada direto na linha, em vez de simular o eco: o eco depende
    // do `receiveCallbackSentByMe` da instância e de um sleep de 2s dentro do
    // `tratarEco`, e o que está sob teste aqui é o portão do turno, não o
    // detector de takeover (esse é o `test-webhook-http`).
    {
      await post(msg({ phone: WA_ASSUMIDO, messageId: 'ASSUM1', text: { message: 'oi, queria agendar' } }));
      await esperarTurnoRodando(WA_ASSUMIDO);
      await conv.pauseConversation(WA_ASSUMIDO);

      await esperarAte(
        () => logTem(/pausada — a equipe assumiu/i) || enviosDe(WA_ASSUMIDO).length > 0,
        'o turno perceber que a equipe assumiu (ou falar por cima dela)',
      );
      await espera(3000); // se fosse enviar mesmo assim, seria agora

      assert.deepStrictEqual(
        enviosDe(WA_ASSUMIDO),
        [],
        'a Bruna assumiu durante a geração: NENHUMA bolha sai (print de 11/08/2026)',
      );
      await conferirEnvios(WA_ASSUMIDO, 0);
    }

    assert.deepStrictEqual(inesperados, [], 'o app só chamou os endpoints Z-API que o stub conhece');
    console.log(
      `test-turno-concorrencia: todos os asserts passaram ✔ (${envios.length} bolhas, ${leituras} marcações de lida)`,
    );
  } finally {
    matar(proc);
    zapi.close();
    await limpar();
    await query(`DELETE FROM app_config WHERE key LIKE 'legado_%' OR key = 'camila_muda'`);
    await getPool().end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
