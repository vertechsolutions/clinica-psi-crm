/**
 * Testes do núcleo puro da validação de comprovante (sem Gemini).
 * Rodar:  npx tsx scripts/test-comprovante-core.ts
 */
import assert from 'node:assert';
import {
  verificarDestinatario,
  montarMarcadorComprovante,
  type AnaliseComprovante,
} from '../src/lib/comprovante-core';

const ESPERADO = 'Chave Pix (celular): +55 27 98117-8233 — em nome de Bruna (Clínica Cazule)';

const base: AnaliseComprovante = {
  ehComprovante: true,
  valor: 280,
  nomeDestinatario: 'Bruna Amorim',
  chaveDestino: '+55 27 98117-8233',
  instituicao: 'Nubank',
  dataHora: '20/07/2026 14:03',
};

// chave em formatos diferentes → CONFERE (comparação por sufixo de dígitos)
assert.strictEqual(verificarDestinatario(base, ESPERADO), 'confere');
assert.strictEqual(verificarDestinatario({ ...base, chaveDestino: '(27) 98117-8233' }, ESPERADO), 'confere');
assert.strictEqual(verificarDestinatario({ ...base, chaveDestino: '5527981178233' }, ESPERADO), 'confere');

// chave claramente OUTRA → NÃO CONFERE
assert.strictEqual(verificarDestinatario({ ...base, chaveDestino: '+55 11 91234-5678' }, ESPERADO), 'nao_confere');

// chave mascarada/ausente mas nome bate → confere (sinal fraco aceito)
assert.strictEqual(verificarDestinatario({ ...base, chaveDestino: null }, ESPERADO), 'confere');
// chave ausente e nome diferente → inconclusivo (OCR de nome é frágil; não acusa)
assert.strictEqual(
  verificarDestinatario({ ...base, chaveDestino: null, nomeDestinatario: 'José Carlos' }, ESPERADO),
  'inconclusivo',
);
// chave e-mail: containment normalizado
assert.strictEqual(
  verificarDestinatario(
    { ...base, chaveDestino: 'financeiro@cazule.com.br' },
    'Chave Pix (e-mail): financeiro@cazule.com.br — em nome de Clínica Cazule',
  ),
  'confere',
);

// marcadores
const mOk = montarMarcadorComprovante(base, 'confere');
assert.ok(/COMPROVANTE/i.test(mOk) && /280/.test(mOk) && /CONFERE/.test(mOk), 'marcador válido');
assert.ok(/valor.*bate|confira.*valor/i.test(mOk), 'instrui a conferir o valor combinado');

const mRuim = montarMarcadorComprovante({ ...base, chaveDestino: '+55 11 91234-5678' }, 'nao_confere');
assert.ok(/N[ÃA]O CONFERE/i.test(mRuim) && /n[ãa]o confirme/i.test(mRuim), 'marcador de chave errada bloqueia');

const mNao = montarMarcadorComprovante({ ...base, ehComprovante: false }, 'inconclusivo');
assert.ok(/N[ÃA]O parece ser um comprovante/i.test(mNao), 'marcador de não-comprovante');

const mFalha = montarMarcadorComprovante(null, 'inconclusivo');
assert.ok(/an[áa]lise autom[áa]tica indispon[íi]vel/i.test(mFalha), 'fallback fail-open');

console.log('test-comprovante-core: todos os asserts passaram ✔');
