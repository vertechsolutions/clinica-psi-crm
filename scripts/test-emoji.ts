/**
 * Testes do filtro de emoji (puro, sem rede, sem banco).
 * Rodar:  npx tsx scripts/test-emoji.ts
 *
 * Pedida da Bruna (06/08/2026): nada que chega ao paciente pode ter emoji — o tom
 * de clínica de psicologia não combina com carinha. O risco do filtro não é deixar
 * emoji passar, é ESTRAGAR o resto: preço com cifrão, acentuação portuguesa, o
 * bullet "•" das listas e o "\n\n" que o splitReply usa pra separar bolha.
 */
import assert from 'node:assert';
import { semEmoji } from '../src/lib/emoji';
import { mensagensDeFechamento } from '../src/lib/fechamento';
import { DEFAULT_PROMPT } from '../src/lib/default-prompt';

// Modificadores invisíveis escritos por codepoint: num arquivo de teste eles
// seriam indistinguíveis a olho nu, e é exatamente deles que o bug nasce.
const ZWJ = '‍'; // zero-width joiner — cola a família num emoji só
const VS16 = '️'; // variation selector-16 — vira a versão colorida do glifo
const KEYCAP = '⃣'; // combining enclosing keycap — o quadradinho do 5️⃣
const FAMILIA = `\u{1F468}${ZWJ}\u{1F469}${ZWJ}\u{1F467}${ZWJ}\u{1F466}`; // 👨‍👩‍👧‍👦
const JOIA_PELE = `\u{1F44D}\u{1F3FD}`; // 👍 + tom de pele médio

// ── preserva o que NÃO é emoji ───────────────────────────────────────────────
// \p{Emoji} casaria dígitos, "#" e "*" — por isso ele é PROIBIDO na implementação.
assert.equal(semEmoji('R$ 180,00'), 'R$ 180,00', 'preço intacto');
assert.equal(semEmoji('R$ 75,00 e R$ 280,00'), 'R$ 75,00 e R$ 280,00', 'dois preços intactos');
assert.equal(
  semEmoji('sessão à distância, é ótimo'),
  'sessão à distância, é ótimo',
  'acentuação portuguesa intacta',
);
assert.equal(semEmoji('• primeiro item'), '• primeiro item', 'bullet intacto');
assert.equal(semEmoji('#1 e *asterisco*'), '#1 e *asterisco*', '# e * não são emoji');
assert.equal(semEmoji('1. item\n2. item'), '1. item\n2. item', 'lista numerada intacta');
assert.equal(
  semEmoji('Manda no https://docs.google.com/forms/d/1A1D/viewform'),
  'Manda no https://docs.google.com/forms/d/1A1D/viewform',
  'link intacto',
);

// ── remove emoji e modificadores ─────────────────────────────────────────────
assert.equal(semEmoji('Olá! 😊'), 'Olá!', 'emoji no fim sai junto com o espaço órfão');
assert.equal(semEmoji(`família ${FAMILIA} toda`), 'família toda', 'sequência ZWJ sai inteira');
assert.equal(semEmoji('família 👨‍👩‍👧‍👦 toda'), 'família toda', 'idem, com o literal do arquivo');
assert.equal(semEmoji(`joia ${JOIA_PELE}`), 'joia', 'tom de pele sai junto');
assert.equal(semEmoji('joia 👍🏽'), 'joia', 'idem, com o literal do arquivo');
assert.equal(semEmoji(`5${VS16}${KEYCAP} sessões`), '5 sessões', 'keycap vira o dígito puro');
assert.equal(semEmoji('5️⃣ sessões'), '5 sessões', 'idem, com o literal do arquivo');
assert.equal(semEmoji(`atenção ⚠${VS16} aqui`), 'atenção aqui', 'variation selector sai');
assert.equal(semEmoji('atenção ⚠️ aqui'), 'atenção aqui', 'idem, com o literal do arquivo');
assert.equal(semEmoji('💙'), '', 'só emoji vira string vazia');
assert.equal(semEmoji('😊 Bom dia'), 'Bom dia', 'emoji no começo');
assert.equal(semEmoji('😊😊😊 oi 😊😊'), 'oi', 'vários emoji seguidos');

// ── espaço órfão colapsa, mas a quebra dupla (separador de bolha) SOBREVIVE ──
assert.equal(semEmoji('bom 😊 dia'), 'bom dia', 'espaço órfão no meio colapsa');
assert.equal(
  semEmoji('linha um 😊\n\nlinha dois'),
  'linha um\n\nlinha dois',
  'a quebra dupla do splitReply não pode ser tocada',
);
assert.equal(
  semEmoji('linha um\n\n😊 linha dois'),
  'linha um\n\nlinha dois',
  'espaço órfão DEPOIS da quebra também some, sem colapsar a quebra',
);
assert.equal(semEmoji('linha um 😊\nlinha dois'), 'linha um\nlinha dois', 'quebra simples preservada');
assert.equal(
  semEmoji('a 😊\n\n\nb'),
  'a\n\n\nb',
  'três quebras continuam três — colapsar quebra é trabalho do splitReply, não daqui',
);

// ── bordas ───────────────────────────────────────────────────────────────────
assert.equal(semEmoji(''), '', 'string vazia');
assert.equal(semEmoji('   '), '', 'só espaço');
assert.equal(semEmoji('  Olá  '), 'Olá', 'trim nas pontas');
assert.equal(semEmoji('a  b'), 'a b', 'espaço duplo colapsa');
assert.equal(semEmoji('a\tb'), 'a\tb', 'tab isolado sobrevive (não é espaço duplo)');

// idempotente: aplicar duas vezes não muda nada (o turno pode filtrar de novo)
const AMOSTRA = 'Oi 😊 tudo bem?\n\nA avulsa é R$ 75,00 👍🏽';
assert.equal(semEmoji(semEmoji(AMOSTRA)), semEmoji(AMOSTRA), 'idempotente');

// ── integração: o filtro não pode alterar as bolhas oficiais ────────────────
// Se alguma mudar, o pós-processamento está agressivo demais — o consertado é a
// implementação, nunca o texto da Bruna.
const LINK = 'https://docs.google.com/forms/d/1A1DWxfinQWBU1oulWQRP7zsmKW6DHL6jjRXzzzX5bhg/viewform';
for (const bolha of mensagensDeFechamento(LINK)) {
  assert.equal(semEmoji(bolha), bolha, `bolha oficial intacta: ${bolha.slice(0, 40)}...`);
}

// ── o prompt não pode MANDAR a Camila usar emoji ─────────────────────────────
// O filtro é a rede; a origem é o prompt. O 👍 que sobra é exemplo do que o
// PACIENTE manda ("se a pessoa só confirma"), não do que a Camila escreve.
for (const proibido of ['😊', '💙']) {
  assert.ok(!DEFAULT_PROMPT.includes(proibido), `DEFAULT_PROMPT sem ${proibido}`);
}
assert.ok(!/com "•" ou um emoji/.test(DEFAULT_PROMPT), 'a instrução de listas não pede emoji');

console.log('test-emoji: todos os asserts passaram ✔');
