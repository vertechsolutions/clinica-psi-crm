/**
 * Testes do portão do pagamento (puro, sem rede, sem banco).
 * Rodar:  npx tsx scripts/test-pagamento.ts
 *
 * Pedida da Bruna por áudio (11/08/2026): *"a IA tá empurrando muito os
 * pagamentos antes da hora. Logo no início da conversa, pedindo comprovante. Às
 * vezes o paciente nem falou um pouquinho da queixa, ou até nem verificou se
 * pode tal horário, nem olhou a disponibilidade de horário e ela já tá
 * empurrando que o paciente envie o comprovante."*
 *
 * No print, o lead responde só "Vou querer o pacote" e a Camila dispara valor +
 * chave Pix + "me envia o comprovante", sem queixa e sem horário. A Bruna
 * comentou nesse mesmo chat: *"Essa ela não agendou... eu assumi o atendimento
 * pra não perder o paciente."*
 *
 * A causa é uma CONTRADIÇÃO dentro do prompt: `default-prompt.ts:138` e `:140`
 * exigem horário aceito antes do pagamento, e `:143` manda enviar o Pix "assim
 * que o paciente escolher avulsa ou pacote", sem condicional. O modelo obedece o
 * imperativo concreto.
 *
 * Metade dos asserts aqui é NEGATIVA, e é a metade que importa mais: negar o Pix
 * a quem está com o celular na mão é o pior desfecho comercial possível, e não é
 * do que a cliente reclamou — ela reclamou de EMPURRAR, não de responder.
 */
import assert from 'node:assert';
import {
  etapaQueFalta,
  liberadoParaPagamento,
  mensagemAntesDoPagamento,
  pacientePediuPagamento,
  tentaCobrar,
} from '../src/lib/pagamento';
import { extrairSinais } from '../src/lib/retomada';

const PIX = 'Chave Pix (CNPJ): 53480459000104 — Cazule Psicologia';
const u = (content: string) => ({ role: 'user' as const, content });
const a = (content: string) => ({ role: 'assistant' as const, content });

// ── tentaCobrar: reconhecer a cobrança ───────────────────────────────────────
// A armadilha: `{PIX_INFO}` já foi substituído na ENTRADA do prompt
// (conversation.ts), então o modelo copia a CHAVE LITERAL, nunca o placeholder.
// Procurar só o placeholder não pegaria nada em produção.
assert.strictEqual(
  tentaCobrar('Você pode fazer o pagamento via Pix pela chave CNPJ: 53480459000104 (Cazule Psicologia).', PIX),
  true,
  'a chave literal copiada do prompt é cobrança',
);
assert.strictEqual(tentaCobrar('Os dados do Pix: {PIX_INFO}', PIX), true, 'placeholder cru também');
assert.strictEqual(
  tentaCobrar('Assim que fizer, me envia o comprovante por aqui, por gentileza.', PIX),
  true,
  'pedir o comprovante ao paciente é cobrança mesmo sem a chave',
);
assert.strictEqual(tentaCobrar('Vou te enviar a chave Pix agora.', PIX), true);

// o falso positivo que substituiria uma EXPLICAÇÃO legítima do processo
assert.strictEqual(
  tentaCobrar(
    'Assim que você confirma o pagamento, eu te envio um formulário de triagem. O formulário vem depois do comprovante, nunca antes.',
    PIX,
  ),
  false,
  'explicar o processo NÃO é cobrar (não há chave nem imperativo dirigido ao paciente)',
);
assert.strictEqual(
  tentaCobrar('As sessões são online, de 45 minutos. A avulsa é R$ 75,00.', PIX),
  false,
  'passar valores não é cobrar',
);
assert.strictEqual(tentaCobrar('', PIX), false);
assert.strictEqual(
  tentaCobrar('Você pode fazer o pagamento via Pix pela chave CNPJ: 53480459000104.', ''),
  true,
  'sem PIX_INFO configurado, ainda pega pelo "chave cnpj"',
);

// ── pacientePediuPagamento: a exceção que não pode travar a venda ────────────
assert.strictEqual(pacientePediuPagamento('como eu pago?'), true);
assert.strictEqual(pacientePediuPagamento('Me manda a chave do Pix, por favor'), true);
assert.strictEqual(pacientePediuPagamento('quero pagar agora'), true);
assert.strictEqual(pacientePediuPagamento('qual é a chave?'), true);
assert.strictEqual(pacientePediuPagamento('Vou querer o pacote'), false, 'escolher pacote NÃO é pedir o Pix');
assert.strictEqual(pacientePediuPagamento('quanto custa?'), false, 'perguntar preço não é pedir o Pix');
assert.strictEqual(pacientePediuPagamento(''), false);

// ── horarioAceito: proposta é uma coisa, ACEITE é outra ──────────────────────
const propos = a('A quinta às 18h está livre com a Larissa, quer que eu reserve?');

const soPropos = extrairSinais([u('quero terapia'), propos]);
assert.strictEqual(soPropos.horarioProposto, true, 'a Camila propôs');
assert.strictEqual(soPropos.horarioAceito, false, 'mas ninguém aceitou ainda');

const aceitou = extrairSinais([u('quero terapia'), propos, u('pode ser, quinta às 18h')]);
assert.strictEqual(aceitou.horarioAceito, true, 'o paciente aceitou depois da proposta');

const aceiteCurto = extrairSinais([u('oi'), propos, u('combinado')]);
assert.strictEqual(aceiteCurto.horarioAceito, true, '"combinado" depois da proposta é aceite');

// a ORDEM importa: um "pode ser" solto ANTES de qualquer proposta não é aceite
const antesDaProposta = extrairSinais([u('pode ser'), a('Vou verificar a agenda.'), u('ok')]);
assert.strictEqual(antesDaProposta.horarioAceito, false, 'aceite antes da proposta não conta');

// ── o portão ─────────────────────────────────────────────────────────────────
// Só o horário aceito bloqueia. Queixa e disponibilidade escolhem a FRASE, não
// travam: quem chega dizendo "quero marcar, quinta às 10h serve" não pode ser
// obrigado a contar a queixa primeiro — o funil é ordem sugerida, não contrato.
assert.strictEqual(
  liberadoParaPagamento({ horarioAceito: false, queixaColetada: true, disponibilidade: true }),
  false,
  'sem horário aceito, o pagamento não sai',
);
assert.strictEqual(
  liberadoParaPagamento({ horarioAceito: true, queixaColetada: false, disponibilidade: false }),
  true,
  'com horário aceito, sai — mesmo sem queixa registrada',
);

// ── O CASO DO PRINT, montado por inteiro ─────────────────────────────────────
const doPrint = [
  u('quanto custa?'),
  a('A avulsa é R$ 75,00 e o pacote mensal sai por R$ 280,00. Como posso te chamar?'),
  u('Lanay'),
  u('Vou querer o pacote'),
];
const sinaisDoPrint = extrairSinais(doPrint);
const respostaDoPrint =
  'Perfeito! O pacote mensal tem 4 sessões e sai por R$ 280,00. ' +
  'Você pode fazer o pagamento via Pix pela chave CNPJ: 53480459000104 (Cazule Psicologia). ' +
  'Assim que fizer, me envia o comprovante por aqui, por gentileza.';

assert.strictEqual(sinaisDoPrint.horarioAceito, false, 'no print não houve horário nenhum');
assert.strictEqual(sinaisDoPrint.opcaoEscolhida, true, 'mas o paciente escolheu o pacote');
assert.strictEqual(tentaCobrar(respostaDoPrint, PIX), true, 'e a Camila tentou cobrar');
assert.strictEqual(
  liberadoParaPagamento({ horarioAceito: false, queixaColetada: false, disponibilidade: false }),
  false,
  'o portão fecha: é o print de 11/08/2026',
);
assert.strictEqual(
  etapaQueFalta({ horarioAceito: false, queixaColetada: false, disponibilidade: false }),
  'queixa',
  'e a etapa a puxar é a primeira pendente do funil',
);
assert.strictEqual(
  etapaQueFalta({ horarioAceito: false, queixaColetada: true, disponibilidade: false }),
  'disponibilidade',
);
assert.strictEqual(
  etapaQueFalta({ horarioAceito: false, queixaColetada: true, disponibilidade: true }),
  'horario',
);

// ── O CASO NEGATIVO: a venda legítima passa intacta ──────────────────────────
// Sem este assert o guard viraria um travão de faturamento.
const legitimo = [u('oi'), propos, u('pode ser, quinta às 18h'), u('vou querer o pacote')];
assert.strictEqual(extrairSinais(legitimo).horarioAceito, true);
assert.strictEqual(
  liberadoParaPagamento({ horarioAceito: true, queixaColetada: true, disponibilidade: true }),
  true,
  'horário aceito + pacote escolhido: o Pix SAI, com a mesma resposta do print',
);

// ── a mensagem de substituição tem que puxar a etapa, não pedir "ok" ─────────
for (const etapa of ['queixa', 'disponibilidade', 'horario'] as const) {
  const m = mensagemAntesDoPagamento(etapa);
  assert.ok(m.includes('?'), `a frase de ${etapa} termina puxando a conversa`);
  assert.ok(!/pix|comprovante|chave/i.test(m), `a frase de ${etapa} não cobra nada`);
  assert.ok(m.length > 20, `a frase de ${etapa} não é um toco`);
}

console.log('OK test-pagamento — 33 asserts (não empurra o Pix, e não trava a venda)');
