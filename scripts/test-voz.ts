/**
 * Testes da decisão "este turno pode falar?" (puro, sem rede, sem banco).
 * Rodar:  npx tsx scripts/test-voz.ts
 *
 * Pedida da Bruna (11/08/2026): "A IA não está desativando quando eu assumo o
 * comando da mensagem." O takeover em si já funcionava — o `tratarEco` do
 * webhook detecta a Bruna digitando e pausa a conversa. O que faltava era o
 * turno EM VÔO reconferir a pausa: ele só olhava o claim (`aindaTitular`), e a
 * leva do debounce alargou a janela entre o gate de entrada e o envio para 8s
 * de janela + 20-40s de Gemini. Nesse buraco a Bruna assumia e a Camila
 * respondia por cima.
 *
 * Aqui mora só a DECISÃO, separada da I/O de propósito: é o coração do bug e
 * não precisa de Postgres pra ser provado. A query que alimenta esta função é
 * exercitada no `test-claim-live.ts`, e o ciclo inteiro no
 * `test-turno-concorrencia.ts`.
 */
import assert from 'node:assert';
import { decidirVoz } from '../src/lib/turno-claim';

const T = 'token-deste-turno';
const OUTRO = 'token-de-outro-turno';

// ── o caso do print: titular legítimo, mas a humana assumiu ──────────────────
assert.strictEqual(
  decidirVoz({ pausada: true, turno_token: T }, T),
  'pausada',
  'o titular LEGÍTIMO cala quando a conversa foi pausada durante o turno',
);

// ── operação normal: a Camila fala ───────────────────────────────────────────
assert.strictEqual(
  decidirVoz({ pausada: false, turno_token: T }, T),
  'ok',
  'titular e conversa ativa: pode falar',
);
assert.strictEqual(
  decidirVoz({ pausada: null, turno_token: T }, T),
  'ok',
  'linha recém-nascida pelo claim (pausada ainda NULL) não é pausa',
);

// ── o que o `aindaTitular` já protegia continua protegido ────────────────────
assert.strictEqual(
  decidirVoz({ pausada: false, turno_token: OUTRO }, T),
  'sem-titularidade',
  'outro turno assumiu o número: cala',
);
assert.strictEqual(
  decidirVoz({ pausada: false, turno_token: null }, T),
  'sem-titularidade',
  'claim já liberado por outro caminho: cala',
);

// ── precedência do MOTIVO ────────────────────────────────────────────────────
// Quando as duas coisas valem, o log precisa dizer "a equipe assumiu", não
// "corrida de claim": é o primeiro que a operação vai querer enxergar quando a
// Bruna reclamar de novo.
assert.strictEqual(
  decidirVoz({ pausada: true, turno_token: OUTRO }, T),
  'pausada',
  'pausa vence titularidade na hora de EXPLICAR o silêncio',
);

// ── linha ausente ────────────────────────────────────────────────────────────
// Durante um turno a linha SEMPRE existe: o `claimTurno` a cria. Se sumiu, foi
// a retenção (`cleanupExpired`) ou um apagamento LGPD no meio do turno — e nos
// dois casos calar é a única leitura defensável.
assert.strictEqual(
  decidirVoz(undefined, T),
  'sem-titularidade',
  'sem linha no banco não existe titularidade: cala',
);

console.log('OK test-voz — 8 asserts (a pausa cala o turno em vôo)');
