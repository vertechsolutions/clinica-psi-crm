import assert from 'node:assert';
import { splitReply } from '../src/lib/split-message';

// 1) texto curto vira 1 bolha
assert.deepStrictEqual(splitReply('Oi, tudo bem?'), ['Oi, tudo bem?']);

// 2) vazio/whitespace vira lista vazia
assert.deepStrictEqual(splitReply('   \n  '), []);

// 3) dois parágrafos (linha em branco) viram 2 bolhas
assert.deepStrictEqual(
  splitReply('Primeira parte.\n\nSegunda parte.'),
  ['Primeira parte.', 'Segunda parte.'],
);

// 4) parágrafo maior que maxLen quebra por frase, respeitando o limite
//    (maxParts alto pra testar o invariante de tamanho sem o teto de partes)
const grande = splitReply('Frase de teste. '.repeat(60), { maxLen: 120, maxParts: 20 });
assert.ok(grande.length > 1, 'devia quebrar');
assert.ok(grande.every((p) => p.length <= 120), 'toda parte <= maxLen quando não limitado por maxParts');

// 5) respeita o teto de partes (junta o excedente na última)
const muitos = splitReply(
  Array.from({ length: 6 }, (_, i) => `Bloco ${i}.`).join('\n\n'),
  { maxParts: 3 },
);
assert.ok(muitos.length <= 3, 'no máximo maxParts');
assert.ok(muitos[2].includes('Bloco 5'), 'excedente vai pra última parte');

// 6) frase única gigante (sem pontuação) é hard-split no espaço
const semPonto = splitReply('palavra '.repeat(50), { maxLen: 100, maxParts: 20 });
assert.ok(semPonto.every((p) => p.length <= 100), 'hard-split respeita maxLen quando não limitado por maxParts');

// 7) maxParts é teto rígido de contagem: a última bolha absorve o excedente
const capado = splitReply('palavra '.repeat(50), { maxLen: 100, maxParts: 3 });
assert.strictEqual(capado.length, 3, 'nunca mais que maxParts bolhas');

console.log(`OK test-split — 7 asserts`);
