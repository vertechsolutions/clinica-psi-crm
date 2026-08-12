/**
 * Testes de integridade do PROMPT (puro, sem rede, sem banco).
 * Rodar:  npx tsx scripts/test-prompt.ts
 *
 * Não testa comportamento: testa o TEXTO. Existe porque três dos defeitos
 * relatados pela clínica em 11/08/2026 nasceram de linhas específicas do prompt,
 * e nada impedia que voltassem na próxima edição:
 *   · P2 (nome repetido) — o exemplo "Entendi, Marina!" ENSINAVA a forma exata
 *     do defeito, mesmo estando dentro de um "nunca faça";
 *   · P4 (bolha cortada) — "não precisa se preocupar com o tamanho" fazia o
 *     modelo mandar parágrafo único longo, o pior caso do auto-split;
 *   · P5 (pagamento cedo) — a linha do Passo 3 mandava enviar o Pix "assim que o
 *     paciente escolher avulsa ou pacote", contradizendo as duas regras acima
 *     dela que exigem horário aceito.
 *
 * O último assert é o único jeito automatizado de pegar alguém editando o prompt
 * sem bumpar a versão — o que faria o localStorage da tela de calibração servir
 * um prompt velho sem avisar.
 */
import assert from 'node:assert';
import { DEFAULT_PROMPT, PROMPT_VERSION } from '../src/lib/default-prompt';

// ── P2: nada no prompt pode ensinar o vocativo por turno ─────────────────────
assert.ok(
  !/Entendi,\s*Marina/i.test(DEFAULT_PROMPT),
  'o prompt não pode conter a forma exata do defeito ("Entendi, Marina!") nem como contraexemplo',
);
assert.ok(
  /vocativo/i.test(DEFAULT_PROMPT),
  'a regra de variação precisa citar o VOCATIVO, não só a interjeição',
);
assert.ok(
  /parcim[ôo]nia/i.test(DEFAULT_PROMPT),
  'a regra de parcimônia com o nome tem que estar escrita',
);

// ── P4: o prompt não pode delegar o tamanho ao sistema ───────────────────────
assert.ok(
  !/n[ãa]o precisa se preocupar com o tamanho/i.test(DEFAULT_PROMPT),
  'delegar o corte ao sistema produz o parágrafo único longo — o pior caso do split',
);

// ── P5: o pagamento subordinado ao horário aceito ────────────────────────────
assert.ok(
  /hor[áa]rio[^.]{0,80}aceit/i.test(DEFAULT_PROMPT),
  'o Passo 3 tem que condicionar o Pix a um horário ACEITO',
);
assert.ok(
  /escolher\s+(a\s+)?(op[çc][ãa]o|avulsa)[^.]{0,40}N[ÃA]O libera o pagamento/i.test(DEFAULT_PROMPT) ||
    /N[ÃA]O libera o pagamento/i.test(DEFAULT_PROMPT),
  'tem que estar explícito que escolher avulsa/pacote não libera o pagamento',
);
assert.ok(
  /[ÚU]NICA exce[çc][ãa]o/i.test(DEFAULT_PROMPT),
  'a exceção do paciente que PEDE o Pix tem que estar escrita — senão o prompt trava a venda',
);

// ── invariantes que as levas anteriores conquistaram ─────────────────────────
assert.ok(/NUNCA use emoji/i.test(DEFAULT_PROMPT), 'a regra de emoji (leva 12) continua no lugar');
assert.ok(
  /NUNCA marque enviarForm ANTES do comprovante/i.test(DEFAULT_PROMPT),
  'a regra de ouro do formulário continua no lugar',
);

// ── a versão tem que ser bumpada quando o prompt muda ────────────────────────
assert.notStrictEqual(
  PROMPT_VERSION,
  '2026-08-07-cazule-v19-sem-emoji',
  'o prompt mudou nesta leva: PROMPT_VERSION precisa ter sido bumpada',
);
assert.match(PROMPT_VERSION, /^\d{4}-\d{2}-\d{2}-/, 'a versão começa com a data');

console.log('OK test-prompt — 11 asserts (os defeitos não voltam pela edição do prompt)');
