/**
 * Sincroniza o raciocínio da Camila do CÓDIGO para o BANCO de produção.
 *
 * Existe por causa de uma precedência fácil de esquecer: `getActivePrompt()`
 * (`src/lib/conversation.ts:16-27`) lê `app_config.system_prompt` e SÓ cai no
 * `DEFAULT_PROMPT` se a linha estiver ausente ou vazia. Ou seja: editar o
 * `default-prompt.ts` e dar deploy NÃO muda o que a Camila pensa em produção,
 * se alguém já salvou um prompt pelo painel. A limpeza de emoji (06/08/2026) é
 * exatamente esse caso — o filtro `semEmoji` é a rede determinística, mas a
 * origem só some quando o banco recebe o texto novo.
 *
 * Lê e mostra o diff. NÃO grava nada sem `--write` explícito: sobrescrever o
 * prompt de produção é o tipo de coisa que não se faz por engano.
 *
 * Rodar (leitura):  DATABASE_PUBLIC_URL=... npx tsx scripts/sync-prompt.ts
 * Rodar (gravação): DATABASE_PUBLIC_URL=... npx tsx scripts/sync-prompt.ts --write
 *
 * A URL vem do shell, nunca do `.env.local` — é o banco de PRODUÇÃO
 * (`railway variables -s Postgres`).
 */
import { readFileSync } from 'node:fs';
try {
  for (const linha of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = linha.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) {
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  }
} catch {}

const GRAVAR = process.argv.includes('--write');

/** Quantas linhas divergentes imprimir antes de cortar (o prompt tem ~170). */
const MAX_LINHAS_DIFF = 40;

/**
 * Diff por linha (LCS). Um `!==` na string inteira só diz "mudou"; o que a gente
 * precisa ver antes de sobrescrever produção é O QUÊ mudou — e principalmente se
 * há edição da Bruna no banco que o código não tem, que seria destruída.
 */
function diffLinhas(a: string[], b: string[]): Array<{ sinal: ' ' | '-' | '+'; texto: string }> {
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = tamanho da maior subsequência comum de a[i..] e b[j..]
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: Array<{ sinal: ' ' | '-' | '+'; texto: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ sinal: ' ', texto: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ sinal: '-', texto: a[i++] });
    } else {
      out.push({ sinal: '+', texto: b[j++] });
    }
  }
  while (i < n) out.push({ sinal: '-', texto: a[i++] });
  while (j < m) out.push({ sinal: '+', texto: b[j++] });
  return out;
}

const corte = (s: string, n = 150) => (s.length > n ? `${s.slice(0, n)}…` : s);

async function main() {
  const dbUrl = process.env.DATABASE_PUBLIC_URL;
  if (!dbUrl) {
    console.error(
      'DATABASE_PUBLIC_URL ausente. Este script fala com o banco de PRODUÇÃO —\n' +
        'passe a URL pelo shell, não pelo .env.local:\n' +
        '  railway variables -s Postgres        (copie DATABASE_PUBLIC_URL)',
    );
    process.exit(1);
  }

  // db.ts lê DATABASE_URL no topo do módulo: setar ANTES do import dinâmico.
  // Usar o `query`/`setActivePrompt` de verdade (em vez de SQL solto aqui) mantém
  // este script fiel ao que a aplicação faz.
  process.env.DATABASE_URL = dbUrl;
  const { query, getPool } = await import('../src/lib/db');
  const { setActivePrompt } = await import('../src/lib/conversation');
  const { DEFAULT_PROMPT, PROMPT_VERSION } = await import('../src/lib/default-prompt');
  const { semEmoji } = await import('../src/lib/emoji');

  try {
    // Leitura CRUA, não getActivePrompt(): aquele devolve o DEFAULT_PROMPT em
    // fallback, e aqui a diferença entre "não há linha" e "a linha é igual ao
    // default" é justamente o que decide se há trabalho a fazer.
    const { rows } = await query<{ value: string; updated_at: Date }>(
      `SELECT value, updated_at FROM app_config WHERE key = 'system_prompt'`,
    );
    const noBanco = rows[0]?.value ?? null;

    console.log(`versão do código: ${PROMPT_VERSION}`);
    if (noBanco === null) {
      console.log(
        '\nNão há linha `system_prompt` em app_config — a Camila já usa o DEFAULT_PROMPT\n' +
          'do código. Nada a sincronizar.',
      );
      return;
    }
    console.log(`prompt no banco:  ${noBanco.length} caracteres, salvo em ${rows[0].updated_at.toISOString()}`);
    console.log(`prompt no código: ${DEFAULT_PROMPT.length} caracteres`);

    if (noBanco.trim() === DEFAULT_PROMPT.trim()) {
      console.log('\nIdênticos. Nada a fazer.');
      return;
    }

    // O motivo de o script existir: quais linhas do prompt de produção o filtro
    // `semEmoji` mexeria. Cada uma é uma instrução ensinando a Camila a usar emoji.
    const comEmoji = noBanco.split('\n').filter((l) => semEmoji(l) !== l && l.trim() !== '');
    if (comEmoji.length > 0) {
      console.log(`\n⚠ ${comEmoji.length} linha(s) do prompt do BANCO ainda têm emoji:`);
      for (const l of comEmoji.slice(0, 10)) console.log(`    ${corte(l.trim(), 120)}`);
      if (comEmoji.length > 10) console.log(`    … e mais ${comEmoji.length - 10}`);
    }

    const partes = diffLinhas(noBanco.split('\n'), DEFAULT_PROMPT.split('\n'));
    const mudadas = partes.filter((p) => p.sinal !== ' ');
    console.log(`\ndiff banco → código (${mudadas.length} linha(s) divergente(s)):`);
    console.log('  "-" sai do banco   ·   "+" entra do código\n');
    for (const p of mudadas.slice(0, MAX_LINHAS_DIFF)) {
      console.log(`  ${p.sinal} ${corte(p.texto.trim())}`);
    }
    if (mudadas.length > MAX_LINHAS_DIFF) {
      console.log(`  … e mais ${mudadas.length - MAX_LINHAS_DIFF} linha(s)`);
    }

    // Rede contra perda de trabalho: uma linha "-" que NÃO reaparece do lado "+"
    // pode ser edição feita pela Bruna no painel e que o código nunca teve.
    const removidas = mudadas.filter((p) => p.sinal === '-').length;
    const adicionadas = mudadas.filter((p) => p.sinal === '+').length;
    console.log(`\n  ${removidas} linha(s) do banco somem, ${adicionadas} do código entram.`);
    console.log('  Confira acima se alguma linha que some é edição da equipe pelo painel —');
    console.log('  gravar sobrescreve o prompt de produção INTEIRO.');

    if (!GRAVAR) {
      console.log('\nModo leitura. Para aplicar:  ... npx tsx scripts/sync-prompt.ts --write');
      return;
    }

    await setActivePrompt(DEFAULT_PROMPT);
    const { rows: depois } = await query<{ value: string }>(
      `SELECT value FROM app_config WHERE key = 'system_prompt'`,
    );
    if (depois[0]?.value !== DEFAULT_PROMPT) throw new Error('gravou mas o banco não confere');
    console.log(`\n✔ prompt de produção atualizado para ${PROMPT_VERSION}.`);
  } finally {
    await getPool().end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
