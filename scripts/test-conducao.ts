import assert from 'node:assert';
import {
  terminaSemAvancar,
  ehFechamentoLegitimo,
  pedeAcaoDoPaciente,
  perguntasDe,
  repetePergunta,
} from '../src/lib/conducao';

// respostas-bug reais que PARARAM (devem ser detectadas)
assert.equal(terminaSemAvancar('Entendi, Bruna. A dificuldade para dormir pode ser trabalhada na terapia, sim. 😊'), true);
assert.equal(terminaSemAvancar('Perfeito, Caroline! Quinta à tarde é uma ótima opção.'), true);
assert.equal(terminaSemAvancar('Obrigada, Bruna! 😊'), true);

// respostas que AVANÇAM (não devem disparar)
assert.equal(terminaSemAvancar('Quais dias e horários costumam ser melhores pra você?'), false);
assert.equal(terminaSemAvancar('A quinta às 14h com a Bruna Ferreira está livre, quer que eu reserve?'), false);

// fechamentos/limites legítimos (não é bug parar)
assert.equal(ehFechamentoLegitimo('Combinado! Fico à disposição, qualquer coisa me chama 😊'), true);
assert.equal(terminaSemAvancar('Combinado! Fico à disposição 😊'), false);

// pedido de ação do paciente (Passo 3) conta como avanço, mesmo sem "?"
assert.equal(pedeAcaoDoPaciente('Assim que fizer o pagamento, me envie o comprovante por aqui.'), true);
assert.equal(terminaSemAvancar('Assim que fizer o pagamento, me envie o comprovante por aqui.'), false);

// vazio não dispara (tratado noutro lugar)
assert.equal(terminaSemAvancar(''), false);

// ── P3: a MESMA pergunta não conta como avanço ────────────────────────────────
// Pedida da Bruna por áudio (10/08/2026): "sempre que o paciente responde algo,
// ela já encaminha 'você gostaria de agendar uma consulta?'. Tá muito
// repetitivo." A causa estava AQUI: qualquer "?" satisfazia o guard, inclusive o
// mesmo do turno anterior — então o sistema PREMIAVA a reemissão da CTA. O
// prompt manda terminar toda resposta com pergunta; sem etapa nova, o modelo
// reciclava a única que conhecia.
const CTA = 'Você tem alguma dúvida específica ou gostaria de agendar uma primeira sessão?';

assert.equal(perguntasDe(`Sim, atendemos online. ${CTA}`).length, 1, 'extrai a frase interrogativa');
assert.equal(perguntasDe('Nenhuma pergunta aqui.').length, 0);

assert.equal(repetePergunta(CTA, [CTA]), true, 'idêntica é repetição');
assert.equal(
  repetePergunta('Você tem alguma dúvida ou gostaria de agendar uma primeira sessão?', [CTA]),
  true,
  'reformulação levíssima também é repetição (é o que aparece nos prints)',
);
assert.equal(
  repetePergunta('Quais dias e horários costumam ser melhores pra você?', [CTA]),
  false,
  'pergunta de OUTRA etapa do funil não é repetição',
);
assert.equal(repetePergunta(CTA, []), false, 'sem histórico de perguntas, nada é repetição');

// o caso do print, no guard
assert.equal(terminaSemAvancar(CTA, [CTA]), true, 'a MESMA pergunta do turno anterior NÃO é avanço');
assert.equal(terminaSemAvancar(CTA, []), false, 'na primeira vez, a CTA é avanço legítimo');
assert.equal(
  terminaSemAvancar(`Sim, atendemos. ${CTA} Quais dias funcionam melhor pra você?`, [CTA]),
  false,
  'pergunta NOVA junto da CTA velha continua avançando',
);

// ── o falso positivo que não pode acontecer ───────────────────────────────────
// Reenviar a chave Pix a pedido do paciente é LEGÍTIMO (está escrito no
// AVISO_RETRY e no bloco [JÁ TRATADO]). Nenhum guard de P3 bloqueia envio — o
// pior caso é UMA chamada extra ao Gemini — mas o guard também não deve acusar.
assert.equal(
  terminaSemAvancar('Claro! A chave Pix é o CNPJ 53480459000104. Assim que fizer, me envia o comprovante.', [CTA]),
  false,
  'pedido de ação do paciente segue sendo avanço, mesmo sem pergunta nova',
);
assert.equal(
  terminaSemAvancar('Combinado! Fico à disposição.', [CTA]),
  false,
  'fechamento legítimo continua isento',
);

// compatibilidade: sem o segundo argumento, o comportamento é o de antes
assert.equal(terminaSemAvancar(CTA), false, 'assinatura antiga preservada');

console.log('test-conducao: todos os asserts passaram ✔');
