/**
 * Testes da máquina de estados do turno — o debounce inteiro, PURO: sem rede,
 * sem banco, sem um único timer de verdade.
 * Rodar:  npx tsx scripts/test-turno-agenda.ts
 *
 * O print de 06/08/2026: a Camila mandou o MESMO par de bolhas duas vezes às
 * 17:59, porque o webhook respondia POR MENSAGEM e dois `after()` concorrentes
 * leram o mesmo histórico. `turno-agenda.ts` é a metade em memória da correção
 * (juntar a rajada num turno só); este arquivo é o que a mantém honesta.
 *
 * Todo o tempo aqui é VIRTUAL: relógio e fila de timers falsos, avançados à mão.
 * Provar o teto anti-starvation de 30s com `setTimeout` real custaria 30s por
 * assert, e teste que demora é teste que ninguém roda.
 *
 * Nada aqui espia o Map interno nem a existência do timer: só `executar`,
 * `estado()` e as promises que a `registrar` devolve — exatamente o que o
 * webhook vê.
 */
import assert from 'node:assert';
import {
  ACORDAR_MS,
  criarAgenda,
  escolherComprovante,
  esperaDoRetry,
  RETRY_ORCAMENTO_MS,
  TETO_JANELA_MS,
  type Acumulado,
  type ComprovanteDoTurno,
  type ResultadoExecucao,
} from '../src/lib/turno-agenda';
import { TURNO_TTL_SEGUNDOS } from '../src/lib/turno-claim';

/** deixa terminar o que está em microtask (os `await` de dentro do turno). */
const drenar = () => new Promise<void>((r) => setImmediate(r));

/** observa a promise da `registrar` sem bloquear: ela só resolve no fim do turno. */
function rastrear(p: Promise<void>) {
  const est = { resolvida: false };
  void p.then(() => {
    est.resolvida = true;
  });
  return est;
}

/** desistir do claim e ciclo que falha LOGAM alto de propósito; aqui é ruído. */
function silenciarErros() {
  const orig = console.error;
  const linhas: string[] = [];
  console.error = (...args: unknown[]) => {
    linhas.push(args.map(String).join(' '));
  };
  return {
    restaurar: () => {
      console.error = orig;
      return linhas;
    },
  };
}

/**
 * Deixa o primeiro `executar` pendurado até o teste abrir o portão: é assim que
 * se segura "o turno está rodando AGORA", sem timer nenhum, para ver o que
 * acontece com a mensagem que chega no meio dele.
 */
function comPortao(b: ReturnType<typeof criarBancada>) {
  let abrir!: (r: ResultadoExecucao) => void;
  const preso = new Promise<ResultadoExecucao>((res) => {
    abrir = res;
  });
  b.cfg.responder = (_a, n) => (n === 1 ? preso : 'ok');
  return (r: ResultadoExecucao) => abrir(r);
}

const comp = (ehComprovante: boolean | null, verificacao: string, valor: number | null = null): ComprovanteDoTurno => ({
  analise: { ehComprovante, valor },
  verificacao,
});

interface TimerFalso {
  id: number;
  fn: () => void;
  em: number;
}

/** o que o `executar` recebeu, congelado na hora da chamada */
interface ChamadaExecutar extends Acumulado {
  em: number;
}

/** epoch arbitrário: nada na agenda pode assumir que o tempo começa em zero */
const T0 = 1_754_000_000_000;

function criarBancada() {
  const cfg = {
    debounceMs: 8_000,
    /** o que o `executar` devolve na n-ésima chamada (1-based) */
    responder: (_a: Acumulado, _n: number): ResultadoExecucao | Promise<ResultadoExecucao> => 'ok',
  };

  let agora = T0;
  let seq = 0;
  const timers = new Map<number, TimerFalso>();
  const chamadas: ChamadaExecutar[] = [];
  /** as esperas pedidas ao agendador, em ordem — é como o teste lê o teto e o debounce */
  const esperas: number[] = [];
  const ids: number[] = [];
  const cancelados: number[] = [];

  const agenda = criarAgenda({
    executar: async (a) => {
      chamadas.push({ waId: a.waId, nome: a.nome, comprovantes: [...a.comprovantes], em: agora });
      return cfg.responder(a, chamadas.length);
    },
    agendar: (fn, ms) => {
      const id = ++seq;
      esperas.push(ms);
      ids.push(id);
      timers.set(id, { id, fn, em: agora + ms });
      return id;
    },
    cancelar: (t) => {
      cancelados.push(t as number);
      timers.delete(t as number);
    },
    agora: () => agora,
    debounceMs: () => cfg.debounceMs,
  });

  /**
   * Avança o relógio virtual até `agora + ms` disparando, em ordem, os timers que
   * vencerem no caminho — inclusive os agendados durante a passagem. É assim que
   * uma cadeia inteira de retries roda sem um `sleep`.
   */
  async function avancar(ms: number): Promise<void> {
    const alvo = agora + ms;
    for (let voltas = 0; ; voltas++) {
      assert.ok(voltas < 10_000, 'avancar não termina: a agenda está reagendando para sempre');
      const proximo = [...timers.values()]
        .filter((t) => t.em <= alvo)
        .sort((a, b) => a.em - b.em || a.id - b.id)[0];
      if (!proximo) break;
      timers.delete(proximo.id);
      agora = Math.max(agora, proximo.em);
      proximo.fn();
      await drenar();
    }
    agora = alvo;
    await drenar();
  }

  return { agenda, cfg, chamadas, esperas, ids, cancelados, avancar };
}

async function main() {
  // ── uma rajada vira UM turno ───────────────────────────────────────────────
  {
    const b = criarBancada();
    const p1 = rastrear(b.agenda.registrar({ waId: 'A', nome: 'Ana' }));
    const p2 = rastrear(b.agenda.registrar({ waId: 'A' }));
    const p3 = rastrear(b.agenda.registrar({ waId: 'A' }));
    assert.deepStrictEqual(b.agenda.estado(), { pendentes: 1, waIds: ['A'] }, 'três mensagens, UMA janela');

    await b.avancar(7_999);
    assert.strictEqual(b.chamadas.length, 0, 'a janela conta do ÚLTIMO evento: 8s de silêncio, não 8s do primeiro');
    await b.avancar(1);
    assert.strictEqual(b.chamadas.length, 1, 'três mensagens na janela = UM executar (o print de 06/08/2026)');

    // cada mensagem nova cancela quem estava agendado e reagenda
    assert.deepStrictEqual(b.cancelados, b.ids.slice(0, 2), 'a 2ª e a 3ª mensagem cancelaram o timer pendente');
    assert.deepStrictEqual(b.esperas, [8_000, 8_000, 8_000], 'e reagendaram a janela cheia a cada vez');
    assert.ok(p1.resolvida && p2.resolvida && p3.resolvida, 'nenhuma das três requests fica pendurada');
    assert.deepStrictEqual(b.agenda.estado(), { pendentes: 0, waIds: [] }, 'agenda limpa depois do turno');
  }

  // ── o que o turno recebe: último nome não-nulo + todos os comprovantes ──────
  {
    const b = criarBancada();
    const pago = comp(true, 'confere', 200);
    const selfie = comp(false, 'sem_comprovante');
    rastrear(b.agenda.registrar({ waId: 'A', nome: 'Ana', comprovante: pago }));
    rastrear(b.agenda.registrar({ waId: 'A', comprovante: selfie }));
    rastrear(b.agenda.registrar({ waId: 'A', nome: 'Ana Paula' }));
    rastrear(b.agenda.registrar({ waId: 'A' })); // sem nome: não apaga o que já sabíamos
    await b.avancar(8_000);

    assert.strictEqual(b.chamadas[0].nome, 'Ana Paula', 'vale o último nome NÃO-NULO: mensagem sem nome não apaga o que já sabíamos');
    assert.deepStrictEqual(b.chamadas[0].comprovantes, [pago, selfie], 'nenhum anexo da rajada se perde, e a ordem é a de chegada');

    // teto de anexos por janela: lead que spamma foto não faz a memória crescer
    const b2 = criarBancada();
    for (let i = 0; i < 12; i++) rastrear(b2.agenda.registrar({ waId: 'A', comprovante: comp(false, `foto-${i}`) }));
    await b2.avancar(8_000);
    assert.strictEqual(b2.chamadas[0].comprovantes.length, 10, 'a janela tem teto de anexos acumulados');
  }

  // ── dois números não se atrapalham ─────────────────────────────────────────
  {
    const b = criarBancada();
    rastrear(b.agenda.registrar({ waId: 'A' }));
    await b.avancar(4_000);
    rastrear(b.agenda.registrar({ waId: 'B' }));
    assert.deepStrictEqual([...b.agenda.estado().waIds].sort(), ['A', 'B'], 'uma janela por número');

    await b.avancar(4_000);
    assert.deepStrictEqual(b.chamadas.map((c) => c.waId), ['A'], 'a janela de A fechou sozinha, sem arrastar B');
    await b.avancar(4_000);
    assert.deepStrictEqual(b.chamadas.map((c) => c.waId), ['A', 'B'], 'cada número tem o seu turno');
    assert.strictEqual(b.agenda.estado().pendentes, 0);
  }

  // ── teto anti-starvation: quem digita a cada 7s eternamente é respondido ───
  {
    const b = criarBancada();
    rastrear(b.agenda.registrar({ waId: 'A' }));
    for (let i = 1; i <= 4; i++) {
      await b.avancar(7_000);
      assert.strictEqual(b.chamadas.length, 0, `${i * 7}s digitando e nada disparou ainda — o debounce está reagendando`);
      rastrear(b.agenda.registrar({ waId: 'A' }));
    }
    assert.deepStrictEqual(
      b.esperas,
      [8_000, 8_000, 8_000, 8_000, 2_000],
      'a espera é o debounce até o teto de 30s virar o limite — aí encurta para caber nele',
    );

    await b.avancar(1_999);
    assert.strictEqual(b.chamadas.length, 0, 'ainda dentro dos 30s');
    await b.avancar(1);
    assert.strictEqual(b.chamadas.length, 1, 'aos 30s da PRIMEIRA mensagem o turno dispara, o lead digitando ou não');
    assert.strictEqual(b.chamadas[0].em - T0, TETO_JANELA_MS, 'o teto conta da abertura da janela, não da última mensagem');
  }

  // ── claim perdido: retenta em vez de perder a mensagem ─────────────────────
  {
    const b = criarBancada();
    b.cfg.responder = (_a, n) => (n === 1 ? 'claim-perdido' : 'ok');
    const p = rastrear(b.agenda.registrar({ waId: 'A' }));

    await b.avancar(8_000);
    assert.strictEqual(b.chamadas.length, 1, 'o turno rodou e perdeu o claim para outro ciclo');
    assert.strictEqual(p.resolvida, false, 'a request NÃO é liberada: soltá-la faria o Next parar de esperar a retentativa');
    assert.deepStrictEqual(b.agenda.estado(), { pendentes: 1, waIds: ['A'] }, 'a mensagem continua na agenda');

    await b.avancar(999);
    assert.strictEqual(b.chamadas.length, 1, 'espera esperaDoRetry(1) inteiro antes de tentar de novo');
    await b.avancar(1);
    assert.strictEqual(b.chamadas.length, 2, 'retentou — a mensagem não sumiu');
    assert.deepStrictEqual(b.chamadas[1].comprovantes, b.chamadas[0].comprovantes, 'a retentativa leva o mesmo acumulado');
    assert.strictEqual(p.resolvida, true, 'respondida, a request é liberada');
    assert.strictEqual(b.agenda.estado().pendentes, 0);
  }

  // ── a escada do retry ──────────────────────────────────────────────────────
  assert.strictEqual(esperaDoRetry(1), 1_000, 'primeira retentativa em 1s');
  assert.strictEqual(esperaDoRetry(2), 2_000);
  assert.strictEqual(esperaDoRetry(3), 4_000);
  assert.strictEqual(esperaDoRetry(4), 8_000);
  assert.strictEqual(esperaDoRetry(5), 8_000, 'teto em 8s: insiste sem martelar o banco');
  assert.strictEqual(esperaDoRetry(40), 8_000);
  assert.strictEqual(esperaDoRetry(0), 1_000, 'tentativa 0 não vira meio segundo');

  // ── a invariante entre as duas constantes ──────────────────────────────────
  // Quebra em silêncio no dia em que alguém mexer só num dos dois lados: o
  // sintoma não é "atrasa", é mensagem de paciente sem resposta nenhuma.
  assert.ok(
    RETRY_ORCAMENTO_MS > TURNO_TTL_SEGUNDOS * 1_000,
    `um ciclo perdedor tem que sobreviver mais que a vida MÁXIMA do vencedor: RETRY_ORCAMENTO_MS ` +
      `(${RETRY_ORCAMENTO_MS}ms) precisa ser maior que TURNO_TTL_SEGUNDOS (${TURNO_TTL_SEGUNDOS}s = ` +
      `${TURNO_TTL_SEGUNDOS * 1_000}ms). Passado o TTL o claim expira e o retry necessariamente passa.`,
  );

  // ── orçamento estourado: desiste, alto, e solta a request ──────────────────
  {
    const b = criarBancada();
    b.cfg.responder = () => 'claim-perdido';
    const p = rastrear(b.agenda.registrar({ waId: '5527988420050' }));

    const log = silenciarErros();
    await b.avancar(8_000 + RETRY_ORCAMENTO_MS + 60_000);
    const linhas = log.restaurar();

    assert.strictEqual(b.agenda.estado().pendentes, 0, 'em algum momento desiste — não retenta para sempre');
    assert.strictEqual(p.resolvida, true, 'a promise da request resolve: nada fica pendurado no shutdown');
    const primeira = b.chamadas[0].em;
    const ultima = b.chamadas[b.chamadas.length - 1].em;
    assert.ok(
      ultima - primeira > TURNO_TTL_SEGUNDOS * 1_000,
      `insistiu ${Math.round((ultima - primeira) / 1000)}s, mais que o TTL do claim (${TURNO_TTL_SEGUNDOS}s) — ` +
        'a essa altura o claim do vencedor já teria expirado',
    );
    assert.ok(
      linhas.some((l) => /desisti do claim/.test(l)),
      'desiste ALTO: até a varredura de boot rodar, alguém precisa saber que uma mensagem ficou sem resposta',
    );
    assert.ok(
      linhas.some((l) => l.includes('***0050')) && !linhas.some((l) => l.includes('5527988420050')),
      'o log leva só os 4 últimos dígitos do número',
    );
  }

  // ── mensagem que chega NO MEIO do turno ────────────────────────────────────
  {
    const b = criarBancada();
    const abrir = comPortao(b);

    const antes = comp(true, 'confere', 200);
    const durante = comp(false, 'sem_comprovante');
    const p1 = rastrear(b.agenda.registrar({ waId: 'A', comprovante: antes }));
    await b.avancar(8_000);
    assert.strictEqual(b.agenda.estado().pendentes, 0, 'o pendente sai da agenda ANTES de o turno rodar');

    const p2 = rastrear(b.agenda.registrar({ waId: 'A', comprovante: durante }));
    assert.deepStrictEqual(b.agenda.estado(), { pendentes: 1, waIds: ['A'] }, 'a mensagem do meio do turno abre uma janela NOVA');

    abrir('ok');
    await drenar();
    assert.strictEqual(p1.resolvida, true, 'o turno terminou e soltou a request dele');
    assert.deepStrictEqual(b.chamadas[0].comprovantes, [antes], 'o turno que já começou não recebe a mensagem nova');
    assert.strictEqual(p2.resolvida, false, 'a janela nova tem titular próprio');

    await b.avancar(8_000);
    assert.strictEqual(b.chamadas.length, 2, 'a mensagem do meio do turno não foi descartada');
    assert.deepStrictEqual(b.chamadas[1].comprovantes, [durante]);
    assert.strictEqual(p2.resolvida, true);
  }

  // ── mensagem no meio de um turno que PERDE o claim: os anexos são fundidos ─
  {
    const b = criarBancada();
    const abrir = comPortao(b);

    const antes = comp(true, 'confere', 200);
    const durante = comp(false, 'sem_comprovante');
    const p1 = rastrear(b.agenda.registrar({ waId: 'A', nome: 'Ana', comprovante: antes }));
    await b.avancar(8_000);
    // a mensagem nova traz nome PRÓPRIO: é o caso que separa "a janela nova
    // herda o que o perdedor sabia" de "o perdedor sobrescreve a janela nova"
    const p2 = rastrear(b.agenda.registrar({ waId: 'A', nome: 'Ana Paula', comprovante: durante }));

    abrir('claim-perdido');
    await drenar();
    assert.strictEqual(p1.resolvida, true, 'o ciclo perdedor larga a request: quem responde agora é a janela nova');
    assert.strictEqual(p2.resolvida, false);
    assert.deepStrictEqual(b.agenda.estado(), { pendentes: 1, waIds: ['A'] }, 'não nasceu um segundo pendente');

    await b.avancar(8_000);
    assert.strictEqual(b.chamadas.length, 2, 'o ciclo perdedor não reagendou por fora: quem dispara é a janela nova');
    assert.deepStrictEqual(
      b.chamadas[1].comprovantes,
      [antes, durante],
      'o comprovante do ciclo perdedor foi fundido na janela nova, antes do que chegou depois',
    );
    assert.strictEqual(
      b.chamadas[1].nome,
      'Ana Paula',
      'a fusão NÃO sobrescreve o que a janela nova já sabe: o nome mais recente é o que vale, como em qualquer outra mensagem',
    );
    assert.strictEqual(p2.resolvida, true);
  }

  // ── o outro lado da fusão: sem nome novo, o do perdedor sobrevive ──────────
  {
    const b = criarBancada();
    const abrir = comPortao(b);
    rastrear(b.agenda.registrar({ waId: 'A', nome: 'Ana' }));
    await b.avancar(8_000);
    rastrear(b.agenda.registrar({ waId: 'A' })); // mensagem sem nome no meio do turno

    abrir('claim-perdido');
    await drenar(); // deixa a fusão acontecer antes de a janela nova disparar
    await b.avancar(8_000);
    assert.strictEqual(b.chamadas[1].nome, 'Ana', 'o nome que o ciclo perdedor já tinha não se perde na fusão');
  }

  // ── acordar: só serve para quem já perdeu um claim ─────────────────────────
  {
    const b = criarBancada();
    b.cfg.responder = () => 'claim-perdido'; // perde sempre: o pendente segue vivo entre as tentativas
    const p = rastrear(b.agenda.registrar({ waId: 'A' }));
    await b.avancar(8_000); // perdeu: retry da escada agendado para 1s

    b.agenda.acordar('A'); // o turno vencedor terminou e liberou o claim
    await b.avancar(ACORDAR_MS);
    assert.strictEqual(b.chamadas.length, 2, 'acordado, tenta em 250ms em vez de esperar o 1s da escada');

    // O timer de 1s da escada tem que ter MORRIDO no acordar. Se sobrasse, ele
    // dispararia um segundo `disparar` em cima do mesmo pendente — dois turnos
    // concorrentes do mesmo número é literalmente o print de 06/08/2026.
    await b.avancar(1_000 - ACORDAR_MS);
    assert.strictEqual(b.chamadas.length, 2, 'acordar cancelou o timer antigo: nenhum timer solto ficou para trás');

    assert.strictEqual(b.agenda.cancelarJanelas(), 1, 'o pendente segue na agenda, ainda esperando a vez dele');
    await drenar();
    assert.strictEqual(p.resolvida, true, 'e o SIGTERM solta a request que estava presa nele');
  }
  {
    const b = criarBancada();
    const p = rastrear(b.agenda.registrar({ waId: 'A' }));
    const esperasAntes = b.esperas.length;

    b.agenda.acordar('A'); // outro número liberou o claim; este aqui só está digitando
    await b.avancar(ACORDAR_MS);
    assert.strictEqual(b.chamadas.length, 0, 'A REGRA CRÍTICA: acordar um pendente em debounce mataria o debounce que a leva existe para criar');
    assert.strictEqual(b.esperas.length, esperasAntes, 'nem reagendou o disparo');
    assert.deepStrictEqual(b.cancelados, [], 'nem cancelou o timer da janela');

    await b.avancar(8_000 - ACORDAR_MS);
    assert.strictEqual(b.chamadas.length, 1, 'dispara na hora dele: 8s de silêncio');
    assert.strictEqual(p.resolvida, true);
  }
  assert.doesNotThrow(
    () => criarBancada().agenda.acordar('5549999551051'),
    'acordar número sem janela aberta é no-op — acontece a cada turno que termina',
  );

  // ── mensagem nova ENTRE dois retries devolve o pendente à janela legítima ──
  // Diferente do caso da fusão: aqui o `executar` JÁ TERMINOU e o pendente está
  // de volta na agenda esperando o retry, então a mensagem cai no mesmo objeto.
  {
    const b = criarBancada();
    b.cfg.responder = (_a, n) => (n === 1 ? 'claim-perdido' : 'ok');
    const p1 = rastrear(b.agenda.registrar({ waId: 'A' }));
    await b.avancar(8_000);
    assert.deepStrictEqual(b.agenda.estado(), { pendentes: 1, waIds: ['A'] }, 'o pendente voltou para a agenda esperando a vez');

    const p2 = rastrear(b.agenda.registrar({ waId: 'A' })); // o lead voltou a digitar
    await drenar();
    assert.strictEqual(p1.resolvida, true, 'a request nova assumiu o buffer');

    // Isto não é mais um ciclo esperando claim: é uma janela de debounce nova, e
    // acordá-la mataria o debounce (a REGRA CRÍTICA). Sem zerar as tentativas, o
    // pendente continuaria "acordável" pelo resto da vida dele.
    const esperasAntes = b.esperas.length;
    const canceladosAntes = b.cancelados.length;
    b.agenda.acordar('A');
    assert.strictEqual(b.esperas.length, esperasAntes, 'acordar voltou a ser no-op: a mensagem nova zerou as tentativas');
    assert.strictEqual(b.cancelados.length, canceladosAntes, 'nem cancelou o timer da janela nova');
    await b.avancar(ACORDAR_MS);
    assert.strictEqual(b.chamadas.length, 1, 'nada foi antecipado');

    await b.avancar(8_000 - ACORDAR_MS);
    assert.strictEqual(b.chamadas.length, 2, 'a janela nova é de debounce cheio, não o 1s da escada de retry');
    assert.strictEqual(p2.resolvida, true);
  }

  // ── ...e reinicia o orçamento de retry ────────────────────────────────────
  {
    const b = criarBancada();
    b.cfg.responder = () => 'claim-perdido'; // o outro turno está demorando horrores
    rastrear(b.agenda.registrar({ waId: 'A' }));
    await b.avancar(8_000 + 100_000); // queima 100s dos 120s de orçamento
    assert.strictEqual(b.agenda.estado().pendentes, 1, 'ainda dentro do orçamento, insistindo');

    rastrear(b.agenda.registrar({ waId: 'A' })); // o lead escreve de novo
    await b.avancar(8_000 + 100_000);
    assert.strictEqual(
      b.agenda.estado().pendentes,
      1,
      'a mensagem nova reinicia o orçamento: herdando os 100s já gastos, este ciclo desistiria cedo — e desistir é a mensagem do paciente ficar sem resposta nenhuma',
    );
    assert.strictEqual(b.agenda.cancelarJanelas(), 1, 'e o SIGTERM ainda a encontra na agenda');
  }

  // ── executar que LANÇA não pendura a request nem derruba a agenda ──────────
  {
    const b = criarBancada();
    b.cfg.responder = () => {
      throw new Error('o Gemini caiu no meio do turno');
    };
    const p1 = rastrear(b.agenda.registrar({ waId: 'A' }));

    const log = silenciarErros();
    await b.avancar(8_000);
    const linhas = log.restaurar();

    assert.strictEqual(p1.resolvida, true, 'erro no ciclo não deixa a promise do after() pendurada até o fim do grace period');
    assert.deepStrictEqual(b.agenda.estado(), { pendentes: 0, waIds: [] }, 'nem lixo na agenda');
    assert.ok(linhas.some((l) => /ciclo falhou/.test(l)), 'o erro real vai para o log');

    b.cfg.responder = () => 'ok';
    const p2 = rastrear(b.agenda.registrar({ waId: 'A' }));
    await b.avancar(8_000);
    assert.strictEqual(b.chamadas.length, 2, 'a agenda continua de pé para a próxima mensagem');
    assert.strictEqual(p2.resolvida, true);
  }

  // ── troca de titular: a request antiga sai, a nova assume ──────────────────
  {
    const b = criarBancada();
    const p1 = rastrear(b.agenda.registrar({ waId: 'A' }));
    await b.avancar(1_000);
    const p2 = rastrear(b.agenda.registrar({ waId: 'A' }));
    await drenar();

    assert.strictEqual(p1.resolvida, true, 'sem a troca, um lead tagarela prenderia a request nº 1 por minutos');
    assert.strictEqual(p2.resolvida, false, 'quem segura o after() agora é a request nova');
    await b.avancar(8_000);
    assert.strictEqual(p2.resolvida, true);
    assert.strictEqual(b.chamadas.length, 1, 'e ainda assim foi um turno só');
  }

  // ── SIGTERM: cancelarJanelas ───────────────────────────────────────────────
  {
    const b = criarBancada();
    const p1 = rastrear(b.agenda.registrar({ waId: 'A' }));
    const p2 = rastrear(b.agenda.registrar({ waId: 'B' }));

    assert.strictEqual(b.agenda.cancelarJanelas(), 2, 'devolve quantas janelas morreram — é o que o shutdown loga');
    await drenar();
    assert.ok(p1.resolvida && p2.resolvida, 'solta os titulares: o Next não fica esperando o grace period inteiro');
    assert.deepStrictEqual(b.agenda.estado(), { pendentes: 0, waIds: [] }, 'estado zerado');
    assert.deepStrictEqual(b.cancelados, b.ids, 'os dois timers foram cancelados');

    await b.avancar(60_000);
    assert.strictEqual(b.chamadas.length, 0, 'nada responde depois do cancelamento');
    assert.strictEqual(b.agenda.cancelarJanelas(), 0, 'um segundo SIGTERM não tem o que cancelar');
  }

  // ── debounceMs é lido a cada uso, nunca cacheado ───────────────────────────
  {
    const b = criarBancada();
    rastrear(b.agenda.registrar({ waId: 'A' }));
    b.cfg.debounceMs = 500;
    rastrear(b.agenda.registrar({ waId: 'A' }));
    assert.deepStrictEqual(b.esperas, [8_000, 500], 'a segunda mensagem já usou o valor novo');
    await b.avancar(500);
    assert.strictEqual(b.chamadas.length, 1, 'e a janela realmente fechou em 500ms');
  }

  // ── registrar nunca lança: o webhook faz `await` nela ──────────────────────
  {
    const agenda = criarAgenda({
      executar: async () => 'ok',
      agendar: () => {
        throw new Error('agendador indisponível');
      },
      cancelar: () => {},
      agora: () => T0,
      debounceMs: () => 8_000,
    });
    const log = silenciarErros();
    await assert.doesNotReject(
      () => agenda.registrar({ waId: 'A' }),
      'falha ao registrar não pode derrubar o after() inteiro — as outras mensagens do lote morreriam com ele',
    );
    assert.ok(log.restaurar().some((l) => /registro falhou/.test(l)), 'mas o erro aparece no log');
  }

  // ── escolherComprovante: o comprovante que vale para o turno ───────────────
  const pagou = comp(true, 'confere', 200);
  const selfie = comp(false, 'sem_comprovante');
  const outraChave = comp(true, 'nao_confere', 200);
  const naoAnalisado: ComprovanteDoTurno = { analise: null, verificacao: 'inconclusivo' };

  assert.strictEqual(
    escolherComprovante([pagou, selfie]),
    pagou,
    'o válido vence mesmo não sendo o último: o lead pagou e depois mandou uma selfie — "o último vence" responderia "seu anexo não parece um comprovante" para quem acabou de pagar',
  );
  assert.strictEqual(escolherComprovante([selfie, pagou, selfie]), pagou, 'a posição não importa: basta um aceitável na janela');
  assert.strictEqual(escolherComprovante([naoAnalisado, pagou]), pagou, 'anexo que nem foi analisado não tira a vez do comprovante bom');
  assert.strictEqual(escolherComprovante([selfie, outraChave]), outraChave, 'sem nenhum aceitável vale o último — é o que a pessoa acabou de tentar');

  // A cláusula `verificacao !== 'nao_confere'`: o anexo É um comprovante de Pix,
  // mas o Pix foi para OUTRA CHAVE. Sem ela, ele contaria como "aceitável" e
  // venceria a janela — e aí o backstop liberaria um handoff para quem pagou,
  // só que não para a clínica. Os dois asserts abaixo são os que travam isso;
  // com `outraChave` na última posição o resultado é o mesmo com e sem a regra.
  assert.strictEqual(
    escolherComprovante([outraChave, selfie]),
    selfie,
    'anexo de chave não-conferida não vence por ser "comprovante": sem nada aceitável na janela, vale o último',
  );
  assert.strictEqual(
    escolherComprovante([outraChave, pagou]),
    pagou,
    'e não rouba a vez do comprovante que realmente confere, mesmo tendo chegado primeiro',
  );
  assert.strictEqual(escolherComprovante([pagou, outraChave]), pagou, 'comprovante de outra chave não invalida o que já conferia');
  assert.strictEqual(escolherComprovante([]), undefined, 'janela sem anexo nenhum');

  console.log('test-turno-agenda: todos os asserts passaram ✔');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
