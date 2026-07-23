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

// 8) normaliza texto colado após pontuação ("atender.As" → "atender. As"),
//    sem quebrar URLs (ponto seguido de minúscula fica intacto)
assert.deepStrictEqual(
  splitReply('Estou aqui para te atender.As sessões custam R$ 75,00.'),
  ['Estou aqui para te atender. As sessões custam R$ 75,00.'],
);
assert.deepStrictEqual(
  splitReply('O formulário: https://docs.google.com/forms/d/abc/viewform'),
  ['O formulário: https://docs.google.com/forms/d/abc/viewform'],
);

// 9) com o default novo (350), um bloco corrido longo (> 350 chars, sem \n\n)
//    quebra em 2+ bolhas por frase
const corridoLongo =
  'As sessões são online, por chamada de vídeo, com duração de 45 minutos. ' +
  'A avulsa é R$ 75,00 e o pacote mensal de 4 sessões sai por R$ 280,00, com desconto. ' +
  'Também temos a opção quinzenal, com 2 sessões por mês, por R$ 150,00. ' +
  'O pagamento é via Pix, e assim que você me enviar o comprovante eu já reservo o seu horário. ' +
  'Você prefere atendimento individual ou de casal, pra eu te passar os detalhes certinhos?';
assert.ok(corridoLongo.length > 350, 'sanity: o texto de teste deve passar do teto');
const bolhas = splitReply(corridoLongo);
assert.ok(bolhas.length >= 2, 'bloco corrido > 350 deve virar 2+ bolhas com o default novo');
assert.ok(bolhas.every((b) => b.length <= 350), 'toda bolha respeita o teto default de 350');

// 10) parágrafo único multi-frase (< maxLen, sem \n\n) é repartido em 2+ bolhas
//     pelo auto-split — garante os balões mesmo se o modelo não pular linha
const infoInicial =
  'As sessões são online, por chamada de vídeo, com duração de 45 minutos. ' +
  'A avulsa é R$ 75,00 e o pacote mensal (4 sessões, uma por semana) sai por R$ 280,00. ' +
  'O pagamento é via Pix. Como posso te chamar?';
assert.ok(infoInicial.length > 180 && infoInicial.length < 350, 'sanity: entre 180 e 350 (não cai no backstop)');
const infoBolhas = splitReply(infoInicial);
assert.ok(infoBolhas.length >= 2, 'parágrafo único multi-frase deve virar 2+ bolhas (auto-split)');

// 11) resposta curta (poucas frases) NÃO é picotada pelo auto-split
assert.deepStrictEqual(splitReply('Oi, Murilo! Que bom que você veio 😊'), ['Oi, Murilo! Que bom que você veio 😊']);

console.log(`OK test-split — 12 asserts (backstop 350 + auto-split)`);
