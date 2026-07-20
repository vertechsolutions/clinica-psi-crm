/**
 * Testes do módulo anti-repetição (puro, sem Gemini).
 * Rodar:  npx tsx scripts/test-anti-repeat.ts
 */
import assert from 'node:assert';
import { normalizaComparacao, similaridade, ehRepeticao } from '../src/lib/anti-repeat';

// --- normalizaComparacao ---
assert.strictEqual(normalizaComparacao('  Oi,  TUDO bem?! '), 'oi tudo bem');
assert.strictEqual(normalizaComparacao('a—b (c) "d"'), 'a b c d');

// --- similaridade ---
assert.strictEqual(similaridade('a b c', 'a b c'), 1);
assert.ok(similaridade('a b c d', 'x y z w') < 0.1);
assert.strictEqual(similaridade('', 'a'), 0);

// --- ehRepeticao: o caso REAL do print da Bruna (19/07) ---
const MSG_REAL =
  'Para o caso de vocês, que buscam resolver brigas e melhorar a comunicação, tanto a TCC quanto a abordagem humanista podem ser bem eficazes. A psicanálise também pode ajudar a entender as raízes desses conflitos. Vocês preferem alguma delas ou querem que eu sugira uma para começar?';
assert.ok(ehRepeticao(MSG_REAL, MSG_REAL), 'repetição idêntica deve ser detectada');

// quase igual (pontuação/espaços diferentes) também é repetição
assert.ok(ehRepeticao(MSG_REAL.replace(/\.\s/g, '! '), MSG_REAL), 'quase igual deve ser detectada');

// uma palavra trocada em texto longo continua sendo repetição (>= 0.9)
assert.ok(ehRepeticao(MSG_REAL.replace('eficazes', 'boas'), MSG_REAL));

// resposta genuinamente nova NÃO é repetição
assert.ok(
  !ehRepeticao('Sugiro começarmos pela TCC: ela é ótima pra comunicação e conflitos. Qual o nome de vocês?', MSG_REAL),
  'resposta nova não pode ser flagrada',
);

// sem mensagem anterior → nunca é repetição
assert.ok(!ehRepeticao(MSG_REAL, undefined));

// mensagens curtas legítimas e diferentes não são flagradas
assert.ok(!ehRepeticao('Perfeito, já te chamo por aqui!', 'Qualquer coisa é só me chamar!'));

console.log('test-anti-repeat: todos os asserts passaram ✔');
