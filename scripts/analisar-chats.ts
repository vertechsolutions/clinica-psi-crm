/**
 * Análise da FORMA dos identificadores que a Z-API devolve em `GET /chats`.
 *
 * Existe porque o import a seco descartou 389 de 732 chats como "inválidos"
 * (comprimento fora de 10–15 dígitos) e é preciso saber o que são: grupo que não
 * veio marcado? contato com número oculto (@lid)? telefone estrangeiro? Cada
 * resposta leva a uma correção diferente, e descartar paciente antigo por engano
 * é o erro caro.
 *
 * Rodar:  npx tsx --env-file=.env.local scripts/analisar-chats.ts
 *
 * LGPD: NUNCA imprime um telefone. Só distribuição de tamanhos, prefixos de país
 * e sufixos de identificador. As amostras saem mascaradas (4 últimos dígitos).
 */
import { coletarChats } from '../src/lib/wa/zapi';

const mascarar = (s: string) => `***${s.slice(-4)}`;

async function main(): Promise<void> {
  const r = await coletarChats({ pageSize: 100, maxPaginas: 100 });
  if (!r.completo) {
    console.error('coleta incompleta:', r.erro);
    process.exit(1);
  }

  const individuais = r.chats.filter((c) => !c.isGroup);
  console.log(`\n${r.chats.length} chats · ${individuais.length} individuais · ${r.chats.length - individuais.length} marcados como grupo\n`);

  // ── distribuição por quantidade de dígitos ──────────────────────────────────
  const porTamanho = new Map<number, number>();
  for (const c of individuais) {
    const n = c.phone.replace(/\D/g, '').length;
    porTamanho.set(n, (porTamanho.get(n) ?? 0) + 1);
  }
  console.log('Dígitos por identificador (individuais):');
  for (const [tam, qtd] of [...porTamanho.entries()].sort((a, b) => a[0] - b[0])) {
    const faixa = tam >= 10 && tam <= 15 ? 'aceito' : 'DESCARTADO';
    console.log(`  ${String(tam).padStart(2)} dígitos: ${String(qtd).padStart(4)}   ${faixa}`);
  }

  // ── que forma tem o identificador ───────────────────────────────────────────
  const formas = new Map<string, number>();
  const conta = (k: string) => formas.set(k, (formas.get(k) ?? 0) + 1);
  for (const c of individuais) {
    const p = c.phone;
    if (/@lid/i.test(p)) conta('@lid (número oculto)');
    else if (/-group|@g\.us/i.test(p)) conta('id de grupo (sem isGroup)');
    else if (/@broadcast|status@/i.test(p)) conta('broadcast/status');
    else if (/@newsletter/i.test(p)) conta('canal');
    else if (/\D/.test(p)) conta('tem caractere não numérico');
    else conta('só dígitos');
  }
  console.log('\nForma do identificador:');
  for (const [forma, qtd] of [...formas.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${forma.padEnd(28)} ${qtd}`);
  }

  // ── os descartados, em detalhe ──────────────────────────────────────────────
  const descartados = individuais.filter((c) => {
    const n = c.phone.replace(/\D/g, '').length;
    return n < 10 || n > 15;
  });
  console.log(`\n${descartados.length} descartados. Amostra mascarada (forma + tamanho):`);
  for (const c of descartados.slice(0, 8)) {
    const digitos = c.phone.replace(/\D/g, '');
    const sufixo = c.phone.replace(/^[\d+]*/, '') || '(sem sufixo)';
    console.log(`  ${mascarar(digitos)}  ${String(digitos.length).padStart(2)} dígitos  sufixo: ${sufixo}`);
  }

  // ── prefixo de país dos aceitos (55 = Brasil) ───────────────────────────────
  const aceitos = individuais.filter((c) => {
    const n = c.phone.replace(/\D/g, '').length;
    return n >= 10 && n <= 15;
  });
  const paises = new Map<string, number>();
  for (const c of aceitos) {
    const dd = c.phone.replace(/\D/g, '').slice(0, 2);
    paises.set(dd, (paises.get(dd) ?? 0) + 1);
  }
  console.log('\nPrefixo dos aceitos:');
  for (const [pre, qtd] of [...paises.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    console.log(`  ${pre}: ${qtd}${pre === '55' ? ' (Brasil)' : ''}`);
  }
  console.log('');
}

main().catch((e) => {
  console.error('[analisar-chats] erro:', e instanceof Error ? e.message : e);
  process.exit(1);
});
