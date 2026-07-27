import assert from 'node:assert';
import { extrairSinais, proximaEtapa, blocoOndeParamos, type MensagemHistorico } from '../src/lib/retomada';
import { montarMarcadorComprovante, type AnaliseComprovante } from '../src/lib/comprovante-core';

const h = (role: 'user' | 'assistant', content: string, at?: Date): MensagemHistorico => ({ role, content, at });
const ONTEM = new Date('2026-07-26T20:00:00Z');
const HOJE = new Date('2026-07-27T09:00:00Z');

// primeiro contato: sem bloco
assert.equal(blocoOndeParamos([h('user', 'oi, boa tarde')]), '', 'primeiro contato nao ganha bloco');

// mesma conversa (gap curto): bloco factual, SEM instrucao de saudacao
const agora = new Date('2026-07-27T09:00:00Z');
const doisMin = new Date('2026-07-27T09:02:00Z');
const mesmaConversa: MensagemHistorico[] = [
  h('user', 'oi, quero terapia individual', agora),
  h('assistant', 'A avulsa é R$ 75,00 e o pacote mensal R$ 280,00.', agora),
  h('user', 'entendi', doisMin),
];
const bCurto = blocoOndeParamos(mesmaConversa);
assert.ok(/J[ÁA] TRATADO/.test(bCurto), 'gap curto usa o bloco factual');
assert.ok(!/Cumprimente/i.test(bCurto), 'gap curto NAO manda cumprimentar');
assert.ok(!/primeiro contato/i.test(bCurto), 'gap curto nao fala em reabertura');
assert.ok(/PEDIR de novo/i.test(bCurto), 'permite reenviar quando o paciente pede');
assert.ok(/HIST[ÓO]RICO vence/i.test(bCurto), 'o bloco se declara subordinado ao historico');

// retomada de verdade (dia seguinte): bloco completo
const retomada: MensagemHistorico[] = [
  h('user', 'oi, quero terapia individual', ONTEM),
  h('assistant', 'A avulsa é R$ 75,00 e o pacote mensal R$ 280,00.', ONTEM),
  h('user', 'bom dia, gostaria de agendar', HOJE),
];
const s1 = extrairSinais(retomada);
assert.equal(s1.valores, true, 'detecta valores informados');
assert.equal(s1.modalidade, 'individual', 'detecta modalidade dita pelo paciente');
assert.ok(s1.horasDesdeUltimoContato !== null && s1.horasDesdeUltimoContato > 12, 'calcula o intervalo');
const b1 = blocoOndeParamos(retomada);
assert.ok(/ONDE PARAMOS/.test(b1), 'monta o bloco de retomada');
assert.ok(/voltou/i.test(b1), 'menciona que a pessoa voltou depois');
assert.ok(/boas-vindas/i.test(b1), 'proibe reabrir com boas-vindas');
assert.ok(/Cumprimente/i.test(b1), 'manda cumprimentar em uma frase');

// modalidade: negacao e ambiguidade
assert.equal(extrairSinais([h('user', 'quero individual, não é de casal'), h('assistant', 'ok')]).modalidade, 'individual');
assert.equal(extrairSinais([h('user', 'é individual ou casal?'), h('assistant', 'ok')]).modalidade, null, 'pergunta nao decide');
assert.equal(extrairSinais([h('user', 'quero individual'), h('user', 'na verdade é casal')]).modalidade, 'casal', 'vale a ultima');

// opcao: PERGUNTAR sobre pacote nao e escolher
const perguntaPacote: MensagemHistorico[] = [
  h('user', 'quero individual'),
  h('assistant', 'A avulsa é R$ 75,00 e o pacote mensal R$ 280,00.'),
  h('user', 'tem pacote?'),
];
assert.equal(extrairSinais(perguntaPacote).opcaoEscolhida, false, '"tem pacote?" nao e escolha');
assert.ok(!/comprovante/i.test(proximaEtapa(extrairSinais(perguntaPacote))), 'nao pula pro comprovante');
assert.equal(
  extrairSinais([h('user', 'qual a diferença de avulsa pra pacote?')]).opcaoEscolhida,
  false,
  'comparacao de precos nao e escolha',
);
assert.equal(extrairSinais([h('user', 'prefiro a avulsa mesmo')]).opcaoEscolhida, true, 'decisao explicita conta');

// horario proposto: precisa ser OFERTA da Camila, nao horario de funcionamento
assert.equal(
  extrairSinais([h('assistant', 'A quinta às 18h está livre com a Larissa, quer que eu reserve?')]).horarioProposto,
  true,
);
assert.equal(extrairSinais([h('assistant', 'Consigo te encaixar quinta 13h45.')]).horarioProposto, true, 'formato 13h45');
assert.equal(extrairSinais([h('assistant', 'Posso reservar às 15h de quinta?')]).horarioProposto, true, 'hora antes do dia');
assert.equal(
  extrairSinais([h('assistant', 'Atendemos de segunda a sexta, das 8h às 20h.')]).horarioProposto,
  false,
  'horario de funcionamento nao e proposta',
);

// funil: so vai pro comprovante quando ha horario proposto E opcao escolhida
const semHorario = [h('user', 'quero individual'), h('assistant', 'Avulsa R$ 75,00.'), h('user', 'prefiro a avulsa')];
assert.ok(!/comprovante/i.test(proximaEtapa(extrairSinais(semHorario))), 'sem horario nao avanca pro pagamento');

// etapa do nome nao pode sumir
assert.ok(/primeiro nome/i.test(proximaEtapa(extrairSinais(retomada), { temNome: false })));
assert.ok(!/primeiro nome/i.test(proximaEtapa(extrairSinais(retomada), { temNome: true })));

// comprovante: usa a MESMA funcao da producao pra montar o marcador
const ANALISE: AnaliseComprovante = {
  ehComprovante: true,
  valor: 75,
  nomeDestinatario: 'Bruna Amorim',
  chaveDestino: '53480459000104',
  instituicao: 'Nubank',
  dataHora: '27/07/2026 10:00',
};
const ok = [h('user', 'quero individual'), h('user', montarMarcadorComprovante(ANALISE, 'confere'))];
assert.equal(extrairSinais(ok).comprovanteOk, true, 'comprovante valido detectado');
assert.equal(extrairSinais(ok).comprovanteRecusado, false);

const recusado = [
  h('user', 'quero individual'),
  h('user', montarMarcadorComprovante({ ...ANALISE, chaveDestino: '+55 11 91234-5678' }, 'nao_confere')),
];
const sRec = extrairSinais(recusado);
assert.equal(sRec.comprovanteRecusado, true, 'chave errada e comprovante RECUSADO');
assert.equal(sRec.comprovanteOk, false, 'recusado nunca conta como valido');
const etapaRec = proximaEtapa(sRec);
assert.ok(!/encerrar/i.test(etapaRec), 'NUNCA manda encerrar em cima de comprovante recusado');
assert.ok(/novo|correta|n[ãa]o foi aceito/i.test(etapaRec), 'manda pedir pagamento correto');

const naoComprovante = [h('user', montarMarcadorComprovante({ ...ANALISE, ehComprovante: false }, 'inconclusivo'))];
assert.equal(extrairSinais(naoComprovante).comprovanteOk, false, 'imagem qualquer nao vira comprovante');

console.log('test-retomada: todos os asserts passaram ✔');
