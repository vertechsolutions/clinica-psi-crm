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

// recusa nao pode ser pegajosa: paciente pagou pra chave errada e REFEZ certo
const refezOPix = [
  h('user', 'quero individual'),
  h('user', montarMarcadorComprovante({ ...ANALISE, chaveDestino: '+55 11 91234-5678' }, 'nao_confere')),
  h('assistant', 'Esse comprovante parece ter sido feito para outro destinatário, pode verificar?'),
  h('user', montarMarcadorComprovante(ANALISE, 'confere')),
];
const sRefez = extrairSinais(refezOPix);
assert.equal(sRefez.comprovanteOk, true, 'vale o ULTIMO anexo: comprovante refeito e valido');
assert.equal(sRefez.comprovanteRecusado, false, 'recusa antiga nao fica pegajosa');

// analise indisponivel conta como comprovante recebido (e o que o marcador manda)
assert.equal(
  extrairSinais([h('user', montarMarcadorComprovante(null, 'inconclusivo'))]).comprovanteOk,
  true,
  'analise indisponivel = possivel comprovante',
);

// foto qualquer SEM Pix combinado: sinal separado, e nunca vira cobranca
const soUmaFoto = [
  h('user', 'oi, tudo bem?'),
  h('user', montarMarcadorComprovante({ ...ANALISE, ehComprovante: false }, 'inconclusivo')),
];
const sFoto = extrairSinais(soUmaFoto);
assert.equal(sFoto.anexoNaoComprovante, true, 'imagem qualquer e sinal SEPARADO');
assert.equal(sFoto.comprovanteRecusado, false, 'imagem qualquer nao e recusa de pagamento');
assert.ok(
  !/pagamento|comprovante/i.test(proximaEtapa(sFoto)),
  'sem Pix enviado, imagem qualquer NAO manda pedir pagamento',
);

// frase da PROPRIA Camila nao pode ligar a recusa (so marcador de anexo classifica)
const camilaFalando = [
  h('user', 'quero individual'),
  h('assistant', 'o valor não confere, pode verificar?'),
];
assert.equal(
  extrairSinais(camilaFalando).comprovanteRecusado,
  false,
  'texto da Camila nao e marcador de anexo',
);

// intervalo: mede desde a ULTIMA fala da Camila, nao desde a mensagem anterior
const TRES_DIAS_ATRAS = new Date('2026-07-24T09:00:00Z');
const VOLTOU = new Date('2026-07-27T09:00:00Z');
const VOLTOU_10S = new Date('2026-07-27T09:00:10Z');
const duasSeguidas: MensagemHistorico[] = [
  h('user', 'oi, quero terapia individual', TRES_DIAS_ATRAS),
  h('assistant', 'A avulsa é R$ 75,00 e o pacote mensal R$ 280,00.', TRES_DIAS_ATRAS),
  h('user', 'bom dia', VOLTOU),
  h('user', 'gostaria de agendar', VOLTOU_10S),
];
const sDuas = extrairSinais(duasSeguidas);
assert.ok(
  sDuas.horasDesdeUltimoContato !== null && sDuas.horasDesdeUltimoContato > 24,
  'gap contado desde a ultima fala da Camila',
);
const bDuas = blocoOndeParamos(duasSeguidas);
assert.ok(/ONDE PARAMOS/.test(bDuas), 'segunda mensagem seguida ainda e retomada');
assert.ok(/3 dias/.test(bDuas), 'informa quantos dias a pessoa ficou fora');

console.log('test-retomada: todos os asserts passaram ✔');
