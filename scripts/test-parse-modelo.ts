/**
 * Testes do parse defensivo da saída do modelo (puro, sem Gemini).
 * Bug real (simulação 20/07): o modelo emitiu JSON com quebras de linha
 * LITERAIS dentro da string "resposta" — JSON inválido — e o fallback antigo
 * mandava o JSON cru como fala pro paciente.
 * Rodar:  npx tsx scripts/test-parse-modelo.ts
 */
import assert from 'node:assert';
import { parseSaidaModelo } from '../src/lib/triagem';

// JSON válido → parse direto
const ok = parseSaidaModelo('{"resposta":"oi","pronto":false}') as Record<string, unknown>;
assert.strictEqual(ok.resposta, 'oi');

// JSON pretty-printed (quebras ESTRUTURAIS são válidas) → parse direto
const pretty = parseSaidaModelo('{\n  "resposta": "oi",\n  "pronto": false\n}') as Record<string, unknown>;
assert.strictEqual(pretty.resposta, 'oi');

// O caso do bug: quebras LITERAIS dentro da string → recupera resposta E ficha
const bruto =
  '{"resposta":"A terapia de casal acontece em 3 etapas.\n\nO objetivo é ajudar vocês. Parece um bom caminho?","lead":{"nome":"Paula"},"pronto":false,"enviarForm":false}';
const rec = parseSaidaModelo(bruto) as Record<string, unknown>;
assert.ok(rec !== null, 'JSON com \\n literal na string deve ser recuperado');
assert.ok(String(rec.resposta).includes('3 etapas'), 'resposta recuperada');
assert.ok(String(rec.resposta).includes('\n\n'), 'quebras de bolha preservadas');
assert.strictEqual((rec.lead as Record<string, unknown>).nome, 'Paula', 'ficha recuperada');

// Irrecuperável → null (o caller suprime em vez de vazar)
assert.strictEqual(parseSaidaModelo('{"resposta": truncado sem fech'), null);
assert.strictEqual(parseSaidaModelo('texto puro que não é json'), null);

console.log('test-parse-modelo: todos os asserts passaram ✔');
