import assert from 'node:assert';
import { decideChannel, MENSAGEM_RETENCAO } from '../src/lib/followup';

const now = new Date('2026-07-17T12:00:00Z');

// dentro de 24h do último inbound -> mensagem livre
assert.strictEqual(decideChannel(new Date('2026-07-17T06:00:00Z'), now), 'freeform');
// mais de 24h -> template
assert.strictEqual(decideChannel(new Date('2026-07-15T06:00:00Z'), now), 'template');
// sem inbound conhecido -> template (conservador)
assert.strictEqual(decideChannel(null, now), 'template');
// exatamente na borda de 24h -> template (não é < 24h)
assert.strictEqual(decideChannel(new Date('2026-07-16T12:00:00Z'), now), 'template');

// Sem exigência de template (Z-API: o transporte é o próprio WhatsApp da
// clínica, não existe janela de 24h) -> sempre texto livre, inclusive no caso
// que na Meta seria template.
assert.strictEqual(decideChannel(new Date('2026-07-15T06:00:00Z'), now, false), 'freeform');
assert.strictEqual(decideChannel(null, now, false), 'freeform');

// a mensagem de retenção é a #7 do FAQ da Bruna
assert.ok(/ainda deseja agendar/i.test(MENSAGEM_RETENCAO));

console.log('OK test-followup — decideChannel');
