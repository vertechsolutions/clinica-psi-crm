/**
 * Testes do núcleo puro da validação de comprovante (sem Gemini).
 * Rodar:  npx tsx scripts/test-comprovante-core.ts
 */
import assert from 'node:assert';
import {
  verificarDestinatario,
  mensagemAnexoInvalido,
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

// chave definitiva da clínica (CNPJ) — comparação por sufixo de 8 dígitos
const PIX_CNPJ = 'Chave Pix (CNPJ): 53480459000104 — em nome de Cazule Psicologia';
assert.strictEqual(verificarDestinatario({ ...base, chaveDestino: '53480459000104' }, PIX_CNPJ), 'confere');
assert.strictEqual(verificarDestinatario({ ...base, chaveDestino: '53.480.459/0001-04' }, PIX_CNPJ), 'confere');
assert.strictEqual(verificarDestinatario({ ...base, chaveDestino: '53480459000104' }, '53480459000104'), 'confere');
assert.strictEqual(verificarDestinatario({ ...base, chaveDestino: '12.345.678/0001-99' }, PIX_CNPJ), 'nao_confere');

// ── Chave MASCARADA pelo banco (o comprovante esconde parte do CNPJ) ──────────
// Sem tolerância aqui, a Camila ACUSA o paciente de ter pago pra outro destinatário
// (o webhook derruba o handoff e manda a mensagemAnexoInvalido). Falso positivo caro.
const daClinica = { nomeDestinatario: 'CAZULE PSICOLOGIA LTDA' };

// dígitos legíveis contíguos e contidos no CNPJ → confere (o sufixo de 8 não bate)
assert.strictEqual(
  verificarDestinatario({ ...base, ...daClinica, chaveDestino: '**.480.459/0001-**' }, PIX_CNPJ),
  'confere',
);
// máscara no meio: dígitos não são substring, mas o titular bate → inconclusivo (equipe confere)
assert.strictEqual(
  verificarDestinatario({ ...base, ...daClinica, chaveDestino: '53.•••.•••/0001-04' }, PIX_CNPJ),
  'inconclusivo',
);
// máscara + titular de OUTRA pessoa → segue bloqueando (dois sinais contra)
assert.strictEqual(
  verificarDestinatario(
    { ...base, nomeDestinatario: 'João Silva', chaveDestino: '**.345.678/0001-**' },
    PIX_CNPJ,
  ),
  'nao_confere',
);
// chave inteira e claramente de outro CNPJ → nao_confere mesmo com o nome da clínica
assert.strictEqual(
  verificarDestinatario({ ...base, ...daClinica, chaveDestino: '12.345.678/0001-99' }, PIX_CNPJ),
  'nao_confere',
);

// Coincidência de dígitos NÃO é prova de pagamento. Um terceiro com chave curta
// e inteiramente legível pode ser um pedaço do nosso CNPJ por acaso:
// "34804590" está contido em "53480459000104". Sem máscara visível e sem o
// titular batendo, isso não pode virar "confere" — seria confirmar sessão paga
// com Pix que foi pra outra conta.
assert.strictEqual(
  verificarDestinatario({ ...base, nomeDestinatario: 'João Silva', chaveDestino: '34804590' }, PIX_CNPJ),
  'inconclusivo',
);
// mesma coincidência, mas com o titular da clínica no comprovante → só confirma
// porque há um segundo sinal
assert.strictEqual(
  verificarDestinatario({ ...base, ...daClinica, chaveDestino: '34804590' }, PIX_CNPJ),
  'confere',
);

// ── 3º parâmetro (titular): PIX_CHAVE é só o número, o nome vive na PIX_INFO ──
// chaveEsperada() prioriza PIX_CHAVE — sem passar a PIX_INFO, o titular some e o
// comprovante mascarado/ilegível vira acusação ou inconclusivo à toa.
assert.strictEqual(
  verificarDestinatario({ ...base, ...daClinica, chaveDestino: '53.•••.•••/0001-04' }, '53480459000104', PIX_CNPJ),
  'inconclusivo',
);
assert.strictEqual(
  verificarDestinatario({ ...base, ...daClinica, chaveDestino: null }, '53480459000104', PIX_CNPJ),
  'confere',
);
assert.strictEqual(
  verificarDestinatario({ ...base, ...daClinica, chaveDestino: '**.480.459/0001-**' }, '53480459000104'),
  'confere',
);

// Mensagem determinística do backstop: quando o webhook zera o enviarForm por
// anexo inválido, o rascunho do modelo é descartado (prompt v18) — quem fala com
// o paciente é este texto.
const PIX = 'Chave Pix (CNPJ): 53480459000104 — em nome de Cazule Psicologia';

const mChaveErrada = mensagemAnexoInvalido('nao_confere', PIX);
assert.ok(/outro destinat[áa]rio/i.test(mChaveErrada), 'avisa que o Pix foi pra outro destinatário');
assert.ok(mChaveErrada.includes('53480459000104'), 'repete a chave correta da clínica');

const mNaoComprovante = mensagemAnexoInvalido('nao_comprovante', PIX);
assert.ok(/comprovante/i.test(mNaoComprovante), 'pede o comprovante do Pix');

for (const m of [mChaveErrada, mNaoComprovante]) {
  // Sem comprovante válido não existe fechamento: nada de formulário nem link.
  assert.ok(!/formul[áa]rio/i.test(m), 'não menciona formulário');
  assert.ok(!/link/i.test(m), 'não menciona link');
  // Guard de condução: todo turno tem que avançar a conversa.
  assert.ok(m.trim().endsWith('?'), 'termina em pergunta');
}

// Sem PIX_INFO configurada não inventa chave nem vaza placeholder, mas ainda conduz.
const mSemPix = mensagemAnexoInvalido('nao_confere', '');
assert.ok(!/\{|\}/.test(mSemPix) && mSemPix.trim().endsWith('?'), 'sem PIX_INFO ainda conduz e não vaza placeholder');

console.log('test-comprovante-core: todos os asserts passaram ✔');
