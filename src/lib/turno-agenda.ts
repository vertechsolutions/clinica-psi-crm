/**
 * A máquina de estados do turno: quando responder, o que juntar, e quem segura a
 * request enquanto isso. PURA — nada de banco, Gemini ou WhatsApp aqui, tudo
 * injetado. É o que permite testar o debounce inteiro em milissegundos, sem
 * infraestrutura (`scripts/test-turno-agenda.ts`).
 *
 * O problema (print de 06/08/2026): o webhook respondia POR MENSAGEM. O lead
 * mandava três mensagens seguidas e recebia três respostas — às vezes o mesmo
 * par de bolhas duas vezes, porque dois `after()` corriam concorrentes.
 *
 * A ideia: responder por TURNO. Cada mensagem reagenda o disparo para
 * `debounceMs` de silêncio; quem chega depois cancela quem estava agendado. Uma
 * rajada vira um `executar` só, com tudo junto.
 */

import type { VerificacaoDestinatario } from './comprovante-core';

/** O que o agendador devolve. Opaco de propósito: nos testes é um número. */
export type TimerId = unknown;

/**
 * O anexo de uma mensagem da janela, no mínimo que o turno precisa: o backstop
 * de comprovante só olha `ehComprovante` e `verificacao`, e o alerta de equipe
 * também o `valor`. Estrutural em vez de importar a `AnaliseComprovante` inteira
 * porque este módulo é puro e não tem por que conhecer OCR.
 *
 * `verificacao` é o TIPO FECHADO de `comprovante-core`, nunca `string`: um
 * `'nao_confer'` datilografado no backstop do `turno.ts` passaria despercebido
 * no compilador e liberaria o handoff de quem mandou Pix para a chave errada.
 * O import é só de tipo (some no build) e `comprovante-core` não importa nada,
 * então a pureza deste arquivo continua de pé.
 */
export interface ComprovanteDoTurno {
  analise: { ehComprovante?: boolean | null; valor?: number | null } | null;
  verificacao: VerificacaoDestinatario;
}

export interface EntradaDeTurno {
  waId: string;
  nome?: string;
  comprovante?: ComprovanteDoTurno;
}

/** O que o turno recebe depois que a janela fecha: a rajada inteira, fundida. */
export interface Acumulado {
  waId: string;
  nome?: string;
  comprovantes: ComprovanteDoTurno[];
}

/**
 * `claim-perdido` é o único resultado que a agenda trata de forma especial: quer
 * dizer "outro turno deste mesmo número está rodando agora", e a mensagem
 * precisa esperar a vez em vez de sumir.
 */
export type ResultadoExecucao = 'ok' | 'claim-perdido';

export interface DepsAgenda {
  executar: (a: Acumulado) => Promise<ResultadoExecucao>;
  agendar: (fn: () => void, ms: number) => TimerId;
  cancelar: (t: TimerId) => void;
  agora: () => number;
  /** lido a CADA uso, nunca cacheado — é o que deixa o teste baixar pra 500ms */
  debounceMs: () => number;
}

/**
 * Teto anti-starvation: o lead que digita a cada 7s eternamente adiaria a
 * resposta para sempre. Passados 30s da PRIMEIRA mensagem da janela, responde.
 */
export const TETO_JANELA_MS = 30_000;

/** Depois que o turno vencedor libera o claim, o perdedor tenta quase na hora. */
export const ACORDAR_MS = 250;

const RETRY_BASE_MS = 1_000;
const RETRY_TETO_MS = 8_000;

/**
 * Quanto tempo um ciclo que perdeu o claim insiste antes de desistir.
 *
 * Precisa ser MAIOR que o `TURNO_TTL_SEGUNDOS` do `turno-claim` (90s), e a
 * invariante é essa frase: *um ciclo perdedor sobrevive mais tempo do que a vida
 * máxima possível do ciclo vencedor*. Passado o TTL o claim expira e o retry
 * necessariamente passa.
 *
 * Contar TENTATIVAS em vez de tempo esconde essa relação atrás de uma
 * multiplicação implícita — e quebra no dia em que alguém mexer no `debounceMs`.
 * A consequência de desistir cedo não é "atrasa": é perder a mensagem para
 * sempre, porque nada a reprocessa fora da varredura de boot.
 */
export const RETRY_ORCAMENTO_MS = 120_000;

/** 1s, 2s, 4s, 8s, 8s… — rápido no caso comum, sem martelar no caso ruim. */
export function esperaDoRetry(tentativa: number): number {
  return Math.min(RETRY_TETO_MS, RETRY_BASE_MS * 2 ** Math.max(0, tentativa - 1));
}

/** Anexos de uma janela. Teto pra memória não crescer com lead que spamma foto. */
const MAX_COMPROVANTES = 10;

/** Acima disto, algo está errado (vazamento ou ataque) e queremos ver no log. */
const ALERTA_PENDENTES = 200;

interface Pendente extends Acumulado {
  timer: TimerId | null;
  /** resolve a promise do `after()` que hoje é titular deste wa_id */
  liberar: (() => void) | null;
  /** quantas vezes ESTE ciclo já perdeu o claim */
  tentativas: number;
  /** quando a janela abriu — governa o teto anti-starvation */
  janelaAbertaEm: number;
  /** quando começou a perder claim — governa o orçamento de retry */
  retryDesde: number | null;
}

export interface Agenda {
  /**
   * Acumula a mensagem e (re)agenda o turno. A promise resolve quando a
   * RESPONSABILIDADE sai desta request: ou o turno terminou, ou uma request mais
   * nova assumiu o buffer. Um re-agendamento interno (retry de claim) NÃO
   * resolve — se resolvesse, a retentativa viraria um timer solto e o Next
   * deixaria de esperá-la no shutdown. Nunca lança.
   */
  registrar(e: EntradaDeTurno): Promise<void>;
  /** O turno terminou e liberou o claim: acorda quem estava esperando por ele. */
  acordar(waId: string): void;
  /** SIGTERM: cancela janelas ainda não disparadas e solta os titulares. */
  cancelarJanelas(): number;
  estado(): { pendentes: number; waIds: string[] };
}

export function criarAgenda(d: DepsAgenda): Agenda {
  /**
   * Só existe ESTE mapa. Um segundo mapa de "turnos em andamento" seria uma
   * segunda fonte de verdade competindo com o claim do Postgres, e as duas
   * divergiriam no primeiro crash. Quem serializa é o banco.
   *
   * `disparar` remove o pendente ANTES de executar o turno, então uma mensagem
   * que chega no meio do turno cria um pendente NOVO, com timer e titular
   * próprios — nunca é descartada, e nunca entra no turno que já começou.
   */
  const pendentes = new Map<string, Pendente>();

  function rearmar(p: Pendente): void {
    const restanteDoTeto = p.janelaAbertaEm + TETO_JANELA_MS - d.agora();
    const espera = Math.max(0, Math.min(d.debounceMs(), restanteDoTeto));
    p.timer = d.agendar(() => void disparar(p.waId), espera);
  }

  function soltar(p: Pendente): void {
    const f = p.liberar;
    p.liberar = null;
    f?.();
  }

  async function disparar(waId: string): Promise<void> {
    const p = pendentes.get(waId);
    if (!p) return; // cancelado (SIGTERM) enquanto o timer corria
    pendentes.delete(waId);
    p.timer = null;

    let resultado: ResultadoExecucao = 'ok';
    try {
      resultado = await d.executar({ waId: p.waId, nome: p.nome, comprovantes: p.comprovantes });
    } catch (err) {
      // Um erro aqui não pode deixar a promise do after() pendurada para sempre:
      // o Next esperaria por ela até o fim do grace period a cada shutdown.
      console.error('[turno] ciclo falhou', err);
    }

    if (resultado !== 'claim-perdido') {
      soltar(p);
      return;
    }

    p.tentativas++;
    p.retryDesde ??= d.agora();

    if (d.agora() - p.retryDesde > RETRY_ORCAMENTO_MS) {
      // Desistir ALTO. A varredura de boot é a última rede; até lá, alguém
      // precisa saber que uma mensagem ficou sem resposta.
      console.error(
        `[turno] desisti do claim de ***${waId.slice(-4)} após ${Math.round(
          (d.agora() - p.retryDesde) / 1000,
        )}s — mensagem sem resposta.`,
      );
      soltar(p);
      return;
    }

    // Enquanto estávamos bloqueados, uma mensagem nova pode ter aberto uma
    // janela: ela é mais recente e já tem titular próprio. Funde o que juntamos
    // nela (o comprovante desta rajada não pode sumir) e sai.
    const novo = pendentes.get(waId);
    if (novo) {
      novo.nome ??= p.nome;
      novo.comprovantes.unshift(...p.comprovantes);
      if (novo.comprovantes.length > MAX_COMPROVANTES) {
        novo.comprovantes = novo.comprovantes.slice(-MAX_COMPROVANTES);
      }
      soltar(p);
      return;
    }

    // Mantém o titular: o `after()` desta request continua aguardando, e é por
    // isso que o Next drena a retentativa no SIGTERM em vez de perdê-la.
    p.timer = d.agendar(() => void disparar(waId), esperaDoRetry(p.tentativas));
    pendentes.set(waId, p);
  }

  return {
    registrar(e: EntradaDeTurno): Promise<void> {
      try {
        const agora = d.agora();
        const atual = pendentes.get(e.waId);

        if (atual) {
          if (atual.timer !== null) d.cancelar(atual.timer);
          if (e.nome) atual.nome = e.nome;
          if (e.comprovante && atual.comprovantes.length < MAX_COMPROVANTES) {
            atual.comprovantes.push(e.comprovante);
          }
          // mensagem nova zera o orçamento de retry: a janela recomeçou
          atual.tentativas = 0;
          atual.retryDesde = null;

          // troca de titular: a request antiga sai, esta assume. Sem isto, um
          // lead tagarela prenderia a request nº 1 por minutos.
          const anterior = atual.liberar;
          const p = new Promise<void>((res) => {
            atual.liberar = res;
          });
          anterior?.();
          rearmar(atual);
          return p;
        }

        const novo: Pendente = {
          waId: e.waId,
          nome: e.nome,
          comprovantes: e.comprovante ? [e.comprovante] : [],
          timer: null,
          liberar: null,
          tentativas: 0,
          janelaAbertaEm: agora,
          retryDesde: null,
        };
        const p = new Promise<void>((res) => {
          novo.liberar = res;
        });
        pendentes.set(e.waId, novo);
        rearmar(novo);
        if (pendentes.size > ALERTA_PENDENTES) {
          console.warn(`[turno] ${pendentes.size} janelas abertas — investigar.`);
        }
        return p;
      } catch (err) {
        // O webhook faz `await` disto. Derrubar aqui mataria o after() inteiro.
        console.error('[turno] registro falhou', err);
        return Promise.resolve();
      }
    },

    acordar(waId: string): void {
      const p = pendentes.get(waId);
      // A REGRA CRÍTICA: só acorda quem já perdeu um claim. Um pendente com
      // `tentativas === 0` está na janela legítima de debounce — o lead ainda
      // pode estar digitando, e acordá-lo mataria o debounce que a leva existe
      // para criar.
      if (!p || p.tentativas === 0 || p.timer === null) return;
      d.cancelar(p.timer);
      p.timer = d.agendar(() => void disparar(waId), ACORDAR_MS);
    },

    cancelarJanelas(): number {
      let n = 0;
      for (const p of [...pendentes.values()]) {
        if (p.timer !== null) d.cancelar(p.timer);
        pendentes.delete(p.waId);
        soltar(p);
        n++;
      }
      return n;
    },

    estado() {
      return { pendentes: pendentes.size, waIds: [...pendentes.keys()] };
    },
  };
}

/**
 * O comprovante que vale para o turno.
 *
 * "O último vence" seria uma REGRESSÃO criada pelo debounce: o lead manda o
 * comprovante certo e logo depois uma selfie ("essa sou eu, pode ser essa
 * foto?"). Com o último vencendo, `ehComprovante === false` faria o backstop
 * suprimir o handoff E trocar a resposta por "seu anexo não parece um
 * comprovante" — para quem acabou de pagar. Hoje isso não acontece porque são
 * dois turnos separados e o primeiro já fechou.
 *
 * Regra: se QUALQUER anexo da janela foi lido como comprovante aceitável, ele
 * vence. O backstop existe para barrar quem não pagou, não para punir quem
 * mandou uma foto depois. Sem nenhum aceitável, vale o último — é o que a pessoa
 * acabou de tentar.
 */
export function escolherComprovante<T extends ComprovanteDoTurno>(cs: T[]): T | undefined {
  if (cs.length === 0) return undefined;
  const valido = cs.find((c) => c.analise?.ehComprovante === true && c.verificacao !== 'nao_confere');
  return valido ?? cs[cs.length - 1];
}
