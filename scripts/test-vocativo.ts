/**
 * Testes da poda do vocativo (puro, sem rede, sem banco).
 * Rodar:  npx tsx scripts/test-vocativo.ts
 *
 * Pedida da Bruna (11/08/2026): "Acho que ela está repetindo muito o nome em
 * todas as conversas, seria possível retirar?" Nos prints a corrente é
 * "Entendi, Eldilaine." → "Ótimo, Eldilaine!" → "Perfeito, Eldilaine!" →
 * "De nada, Eldilaine!", quatro turnos seguidos.
 *
 * Guard de CÓDIGO e não só de prompt porque o prompt efetivo vem do
 * `app_config` no Postgres (`conversation.getActivePrompt`) e pode estar
 * congelado numa versão antiga — a regra de parcimônia sozinha já existia e não
 * foi obedecida.
 *
 * A maioria dos asserts aqui é NEGATIVA. O risco desta feature não é deixar
 * passar um "Eldilaine" a mais (incômodo que a cliente já tolerou por semanas):
 * é mutilar uma frase legítima, que é o defeito da bolha cortada voltando pela
 * porta dos fundos.
 */
import assert from 'node:assert';
import { contarVocativos, orcamentoDeVocativo, podarVocativo } from '../src/lib/vocativo';

// ── os quatro vocativos do print ─────────────────────────────────────────────
assert.strictEqual(podarVocativo('Entendi, Eldilaine.', 'Eldilaine', 0), 'Entendi.');
assert.strictEqual(podarVocativo('Ótimo, Eldilaine!', 'Eldilaine', 0), 'Ótimo!');
assert.strictEqual(
  podarVocativo('Perfeito, Eldilaine! As sessões individuais são online.', 'Eldilaine', 0),
  'Perfeito! As sessões individuais são online.',
);
assert.strictEqual(
  podarVocativo('De nada, Eldilaine! Fico à disposição.', 'Eldilaine', 0),
  'De nada! Fico à disposição.',
);

// ── vocativo ANTEPOSTO: some a vírgula e a frase recapitaliza ────────────────
assert.strictEqual(
  podarVocativo('Lanay, o pacote mensal tem 4 sessões.', 'Lanay', 0),
  'O pacote mensal tem 4 sessões.',
);
assert.strictEqual(
  podarVocativo('Claro. Lanay, me diz uma coisa.', 'Lanay', 0),
  'Claro. Me diz uma coisa.',
);

// ── saudação sem vírgula ─────────────────────────────────────────────────────
assert.strictEqual(podarVocativo('Oi Marina! Tudo bem?', 'Marina', 0), 'Oi! Tudo bem?');
assert.strictEqual(podarVocativo('Bom dia, Marina.', 'Marina', 0), 'Bom dia.');

// ── acento não escapa da poda (ficha e fala podem divergir) ──────────────────
assert.strictEqual(podarVocativo('Oi, Terêza! Tudo bem?', 'Tereza', 0), 'Oi! Tudo bem?');
assert.strictEqual(podarVocativo('Entendi, Tereza.', 'Terêza', 0), 'Entendi.');

// ── ORÇAMENTO 1: mantém a PRIMEIRA (a saudação) e corta o resto ──────────────
assert.strictEqual(
  podarVocativo('Perfeito, Eldilaine! Eldilaine, me diz uma coisa.', 'Eldilaine', 1),
  'Perfeito, Eldilaine! Me diz uma coisa.',
);

// ── O QUE NÃO PODE SER TOCADO ────────────────────────────────────────────────
// nome fora de posição de vocativo é conteúdo, não vício de estilo
const naFicha = 'Vou anotar o nome Eldilaine na ficha.';
assert.strictEqual(podarVocativo(naFicha, 'Eldilaine', 0), naFicha, 'nome como objeto da frase fica');
const sujeito = 'A Eldilaine já preencheu o formulário.';
assert.strictEqual(podarVocativo(sujeito, 'Eldilaine', 0), sujeito, 'nome como sujeito fica');
// nome que também é palavra comum: só some em posição de vocativo
assert.strictEqual(podarVocativo('Obrigada, Rosa!', 'Rosa', 0), 'Obrigada!');
const flor = 'Ela ganhou uma rosa no dia da sessão.';
assert.strictEqual(podarVocativo(flor, 'Rosa', 0), flor, 'a palavra comum sobrevive fora do vocativo');

// ── sem nome / entradas degeneradas: devolve intacto ─────────────────────────
const qualquer = 'Perfeito, Eldilaine! Vamos seguir.';
assert.strictEqual(podarVocativo(qualquer, null, 0), qualquer, 'sem nome, não mexe');
assert.strictEqual(podarVocativo(qualquer, '', 0), qualquer, 'nome vazio, não mexe');
assert.strictEqual(podarVocativo(qualquer, '   ', 0), qualquer, 'nome só espaço, não mexe');
assert.strictEqual(podarVocativo('', 'Eldilaine', 0), '', 'texto vazio segue vazio');

// ── a separação de bolhas do splitReply tem que sobreviver ───────────────────
// O `splitReply` usa a LINHA EM BRANCO pra decidir a bolha. Colapsar \n\n aqui
// transformaria a poda do nome no defeito da bolha, que é bem pior.
const duasBolhas = 'Perfeito, Ana!\n\nMe diz uma coisa, Ana.';
const podado = podarVocativo(duasBolhas, 'Ana', 0);
assert.ok(podado.includes('\n\n'), 'a linha em branco que separa as bolhas sobrevive');
assert.ok(!/Ana/.test(podado), 'e os dois vocativos foram embora');

// ── contarVocativos: a base do orçamento ─────────────────────────────────────
assert.strictEqual(contarVocativos('Entendi, Ana. Ana, escuta.', 'Ana'), 2);
assert.strictEqual(contarVocativos('A Ana preencheu a ficha.', 'Ana'), 0, 'só conta vocativo');
assert.strictEqual(contarVocativos('nada aqui', 'Ana'), 0);

// ── orçamento: a janela olha as ÚLTIMAS falas da Camila ──────────────────────
const u = (content: string) => ({ role: 'user' as const, content });
const a = (content: string) => ({ role: 'assistant' as const, content });

assert.strictEqual(
  orcamentoDeVocativo([u('oi'), a('Seja bem-vinda! Como posso te chamar?'), u('Ana')], 'Ana'),
  1,
  'ninguém usou o nome ainda: pode usar uma vez',
);
assert.strictEqual(
  orcamentoDeVocativo([a('Entendi, Ana.'), u('ok')], 'Ana'),
  0,
  'a última fala já usou: este turno não usa',
);
// é este que quebra a corrente do print: com janela 1, o padrão viraria
// sim-não-sim-não, que ainda soa robótico.
assert.strictEqual(
  orcamentoDeVocativo([a('Entendi, Ana.'), u('ok'), a('Vamos seguir então.'), u('beleza')], 'Ana'),
  0,
  'a PENÚLTIMA fala usou: ainda não pode (janela de 2)',
);
assert.strictEqual(
  orcamentoDeVocativo(
    [a('Entendi, Ana.'), a('Vamos seguir.'), a('Certo.'), a('Perfeito.')],
    'Ana',
  ),
  1,
  'passada a janela, o nome volta a ser permitido',
);
assert.strictEqual(orcamentoDeVocativo([a('Entendi, Ana.')], null), 0, 'sem nome, orçamento zero');

console.log('OK test-vocativo — 27 asserts (o nome com parcimônia, a frase intacta)');
