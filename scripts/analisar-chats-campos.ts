/**
 * Quais CAMPOS a Z-API devolve em `GET /chats` — e quais deles os 389 chats sem
 * `phone` trazem no lugar.
 *
 * Rodar:  npx tsx --env-file=.env.local scripts/analisar-chats-campos.ts
 *
 * LGPD: imprime NOMES de campo e a FORMA do valor (tipo, tamanho, se é só
 * dígitos), nunca o conteúdo. Telefone e nome de contato não aparecem.
 */
const INSTANCE = process.env.ZAPI_INSTANCE_ID;
const TOKEN = process.env.ZAPI_INSTANCE_TOKEN;
const CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN;

/** Descreve o valor sem revelá-lo. */
function forma(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'boolean') return `bool(${v})`;
  if (typeof v === 'number') return `num(${String(v).length} díg)`;
  if (typeof v === 'string') {
    if (v === '') return 'string VAZIA';
    const digitos = v.replace(/\D/g, '');
    if (digitos.length === v.length) return `dígitos(${v.length})`;
    return `texto(${v.length} chars${digitos.length ? `, ${digitos.length} díg` : ''})`;
  }
  if (Array.isArray(v)) return `array(${v.length})`;
  return `objeto{${Object.keys(v as object).join(',')}}`;
}

async function analisar(): Promise<void> {
  const url = `https://api.z-api.io/instances/${INSTANCE}/token/${TOKEN}/chats?page=1&pageSize=100`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (CLIENT_TOKEN) headers['Client-Token'] = CLIENT_TOKEN;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    console.error(`falhou: HTTP ${res.status}`);
    process.exit(1);
  }
  const pagina = (await res.json()) as Record<string, unknown>[];
  console.log(`\npágina 1: ${pagina.length} chats\n`);

  // ── quais chaves existem, e em quantos chats ────────────────────────────────
  const chaves = new Map<string, number>();
  for (const c of pagina) {
    for (const k of Object.keys(c)) chaves.set(k, (chaves.get(k) ?? 0) + 1);
  }
  console.log('Campos presentes (campo: em quantos chats):');
  for (const [k, n] of [...chaves.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(24)} ${n}`);
  }

  // ── separar quem tem phone de quem não tem ──────────────────────────────────
  const semPhone = pagina.filter((c) => !c.phone || String(c.phone).trim() === '');
  const comPhone = pagina.filter((c) => c.phone && String(c.phone).trim() !== '');
  console.log(`\ncom phone: ${comPhone.length}   ·   SEM phone: ${semPhone.length}`);

  const amostra = (rotulo: string, lista: Record<string, unknown>[]) => {
    if (lista.length === 0) return;
    console.log(`\n── ${rotulo} — forma de cada campo (2 amostras) ──`);
    for (const c of lista.slice(0, 2)) {
      console.log('  {');
      for (const [k, v] of Object.entries(c)) console.log(`    ${k.padEnd(22)} ${forma(v)}`);
      console.log('  }');
    }
  };
  amostra('CHAT COM PHONE', comPhone);
  amostra('CHAT SEM PHONE', semPhone);

  // ── o `lid` identifica UMA pessoa? ─────────────────────────────────────────
  // O import viu 720 chats com lid mas só 332 valores distintos depois de
  // normalizar pra dígitos — alguns repetindo 5 vezes. Ou o campo não é único, ou
  // a minha normalização está colapsando valores diferentes. Gravar um id que
  // colide calaria pessoas erradas, inclusive lead novo.
  const comLid = pagina.filter((c) => typeof c.lid === 'string' && c.lid);
  const crus = new Set(comLid.map((c) => String(c.lid)));
  const normalizados = new Set(comLid.map((c) => String(c.lid).replace(/\D/g, '')));
  console.log(`\nlid — ${comLid.length} chats na página:`);
  console.log(`  valores CRUS distintos:        ${crus.size}`);
  console.log(`  valores NORMALIZADOS distintos: ${normalizados.size}`);
  if (crus.size > normalizados.size) {
    console.log('  ⚠️ a normalização (só dígitos) está colapsando valores distintos!');
  }
  const formatos = new Map<string, number>();
  for (const c of comLid) {
    const v = String(c.lid);
    // descreve o formato sem revelar: substitui dígito por 9 e letra por a
    const molde = v.replace(/\d/g, '9').replace(/[A-Za-z]/g, 'a');
    formatos.set(molde, (formatos.get(molde) ?? 0) + 1);
  }
  console.log('  moldes encontrados (dígito=9, letra=a):');
  for (const [m, n] of [...formatos.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    console.log(`    ${m}  × ${n}`);
  }

  // ── algum campo dos "sem phone" parece um identificador? ────────────────────
  console.log('\nCampos dos "sem phone" que contêm dígitos (candidatos a identificador):');
  const candidatos = new Map<string, number>();
  for (const c of semPhone) {
    for (const [k, v] of Object.entries(c)) {
      if (typeof v === 'string' && v.replace(/\D/g, '').length >= 10) {
        candidatos.set(k, (candidatos.get(k) ?? 0) + 1);
      }
    }
  }
  if (candidatos.size === 0) console.log('  NENHUM — esses chats não trazem identificador algum.');
  for (const [k, n] of candidatos) console.log(`  ${k.padEnd(24)} ${n}`);
  console.log('');
}

analisar().catch((e) => {
  console.error('erro:', e instanceof Error ? e.message : e);
  process.exit(1);
});
