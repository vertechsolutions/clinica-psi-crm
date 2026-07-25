import assert from 'node:assert';
import { primeiroNomeDoPush, blocoContatoDe } from '../src/lib/contato';

// primeiroNomeDoPush: extrai nome de pessoa do pushName livre do WhatsApp
assert.equal(primeiroNomeDoPush('Bruna Amorim'), 'Bruna');
assert.equal(primeiroNomeDoPush('maria 🦋'), 'Maria');
assert.equal(primeiroNomeDoPush('MARIANA'), 'Mariana');
assert.equal(primeiroNomeDoPush('Pedro Silva'), 'Pedro');
assert.equal(primeiroNomeDoPush('Clínica Cazule'), null); // empresa
assert.equal(primeiroNomeDoPush('Loja do João'), null);   // empresa
assert.equal(primeiroNomeDoPush('iPhone de João'), null); // aparelho
assert.equal(primeiroNomeDoPush('😎'), null);
assert.equal(primeiroNomeDoPush(''), null);
assert.equal(primeiroNomeDoPush(undefined), null);

// blocoContatoDe: prioridade ficha > pushName; vazio quando não há nome
const bFicha = blocoContatoDe('Bruna', undefined);
assert.ok(/Bruna/.test(bFicha) && /nunca pergunte o nome/i.test(bFicha), 'ficha: usa nome + proíbe re-perguntar');
const bPush = blocoContatoDe(null, 'Pedro Silva');
assert.ok(/Pedro/.test(bPush) && /whatsapp/i.test(bPush), 'push: usa 1º nome do WhatsApp');
assert.equal(blocoContatoDe(null, null), '');
assert.equal(blocoContatoDe(null, 'Clínica X'), ''); // push filtrado -> sem bloco
assert.equal(blocoContatoDe('  ', undefined), '');    // ficha vazia -> sem bloco

console.log('test-contato: todos os asserts passaram ✔');
