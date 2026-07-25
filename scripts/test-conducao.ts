import assert from 'node:assert';
import { terminaSemAvancar, ehFechamentoLegitimo, pedeAcaoDoPaciente } from '../src/lib/conducao';

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

console.log('test-conducao: todos os asserts passaram ✔');
