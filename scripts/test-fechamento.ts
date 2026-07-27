import assert from 'node:assert';
import {
  mensagensDeFechamento,
  bolhasDoTurno,
  FECHAMENTO_FORMULARIO,
  FECHAMENTO_CONFIRMACAO,
  FECHAMENTO_DUVIDA,
  FECHAMENTO_REMANEJAMENTO,
} from '../src/lib/fechamento';

const LINK = 'https://docs.google.com/forms/d/1A1DWxfinQWBU1oulWQRP7zsmKW6DHL6jjRXzzzX5bhg/viewform';
const bolhas = mensagensDeFechamento(LINK);

// 4 bolhas, na ordem que a Bruna definiu em 27/07/2026
assert.equal(bolhas.length, 4, 'sao 4 mensagens');
assert.equal(bolhas[0], `${FECHAMENTO_FORMULARIO} ${LINK}`);
assert.equal(bolhas[1], FECHAMENTO_CONFIRMACAO);
assert.equal(bolhas[2], FECHAMENTO_DUVIDA);
assert.equal(bolhas[3], FECHAMENTO_REMANEJAMENTO);

// texto exato da Bruna — qualquer edicao aqui e mudanca de PRODUTO, nao de codigo
assert.equal(
  FECHAMENTO_FORMULARIO,
  'Este é o nosso formulário, solicito que seja preenchido, pois é através dele que realizaremos o envio da sua triagem para a psicóloga:',
);
assert.equal(
  FECHAMENTO_CONFIRMACAO,
  'Confirmação realizada, após o preenchimento da triagem a psicóloga vai entrar em contato com você pelo WhatsApp.',
);
assert.equal(FECHAMENTO_DUVIDA, 'Caso tenha qualquer dúvida pode me chamar que eu te ajudo.');
assert.equal(
  FECHAMENTO_REMANEJAMENTO,
  'Caso você não se identifique com a profissional, podemos fazer o remanejamento para outra psicóloga, é só nos avisar.',
);

// nenhuma bolha e textao nem tem quebra dupla (cada item e UMA mensagem)
for (const b of bolhas) {
  assert.ok(b.length <= 350, `bolha curta: ${b.length} chars`);
  assert.ok(!b.includes('\n\n'), 'sem paragrafo duplo dentro da bolha');
  assert.equal(b, b.trim(), 'sem espaco sobrando');
}

// sem FORM_URL: primeira mensagem sai sem link e NUNCA com placeholder
const semLink = mensagensDeFechamento('');
assert.equal(semLink.length, 4);
assert.ok(!semLink[0].includes('{FORM_URL}'), 'nunca vaza placeholder');
assert.equal(semLink[0], FECHAMENTO_FORMULARIO);
assert.equal(mensagensDeFechamento('{FORM_URL}')[0], FECHAMENTO_FORMULARIO, 'placeholder cru nao vira link');

// bolhasDoTurno: e o unico ponto que decide fechamento vs resposta do modelo
assert.deepEqual(bolhasDoTurno({ enviarForm: true, resposta: 'qualquer coisa' }, LINK), bolhas);
const normal = bolhasDoTurno({ enviarForm: false, resposta: 'Oi!\n\nComo posso te chamar?' }, LINK);
assert.deepEqual(normal, ['Oi!', 'Como posso te chamar?'], 'sem handoff, reparte a resposta do modelo');

// handoff suprimido pelo backstop => NENHUM texto oficial sai
const suprimido = bolhasDoTurno({ enviarForm: false, resposta: 'O comprovante veio de outra chave, pode conferir?' }, LINK);
assert.ok(!suprimido.some((b) => b.includes(FECHAMENTO_FORMULARIO)), 'sem fechamento quando enviarForm=false');
assert.ok(!suprimido.some((b) => b.includes(LINK)), 'sem link quando enviarForm=false');

console.log('test-fechamento: todos os asserts passaram ✔');
