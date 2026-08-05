/**
 * Testes da COLETA de conversas do aparelho (Z-API `GET /chats`), com `fetch`
 * falso — nada sai pra rede. É o que semeia a lista de legado, então um erro aqui
 * significa a Camila falando dentro de conversa que já era da Bruna.
 *
 * Rodar:  npx tsx scripts/test-zapi-chats.ts
 */
import assert from 'node:assert';

process.env.ZAPI_INSTANCE_ID = 'INST123';
process.env.ZAPI_INSTANCE_TOKEN = 'TOKFALSO123';
process.env.ZAPI_CLIENT_TOKEN = 'CLIENT123';
process.env.WA_PROVIDER = 'zapi';

interface Chamada {
  url: string;
  method: string;
  headers: Record<string, string>;
}

const chamadas: Chamada[] = [];
let respostas: Array<{ ok?: boolean; status?: number; json?: unknown }> = [];

function instalarFetchFalso() {
  chamadas.length = 0;
  respostas = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    chamadas.push({ url: String(input), method: init?.method || 'GET', headers });
    const r = respostas.shift() ?? { json: [] };
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: async () => r.json ?? [],
    } as unknown as Response;
  }) as typeof fetch;
}

const chat = (phone: string, extra: Record<string, unknown> = {}) => ({
  phone,
  name: 'Nome Que Não Pode Vazar',
  notes: 'anotação privada do WhatsApp Business',
  lastMessageTime: '1622991687',
  isGroup: false,
  archived: 'false',
  ...extra,
});

async function main() {
  const { coletarChats, mensagemDeErro } = await import('../src/lib/wa/zapi');

  // ── nenhum segredo sobrevive a um texto de erro ────────────────────────────
  // O ZAPI_INSTANCE_TOKEN mora DENTRO da URL, e numa falha de rede a `cause` da
  // undici carrega a URL inteira. Quem tem o token envia WhatsApp como a clínica.
  const cru = new Error(
    'connect ECONNREFUSED https://api.z-api.io/instances/INST123/token/TOKFALSO123/chats',
  );
  const limpo = mensagemDeErro(cru);
  assert.ok(!limpo.includes('TOKFALSO123'), 'token não sobrevive ao texto de erro');
  assert.ok(!limpo.includes('INST123'), 'id da instância também não');
  assert.ok(!limpo.includes('CLIENT123'), 'nem o Client-Token');
  assert.ok(limpo.includes('ECONNREFUSED'), 'mas o motivo continua legível');
  assert.strictEqual(mensagemDeErro('texto solto'), 'texto solto', 'aceita erro que não é Error');

  // ── requisição: URL, método e a trava da conta ──────────────────────────────
  instalarFetchFalso();
  respostas.push({ json: [chat('5527999990001')] });
  respostas.push({ json: [] });
  let r = await coletarChats({ pageSize: 100 });

  assert.strictEqual(
    chamadas[0].url,
    'https://api.z-api.io/instances/INST123/token/TOKFALSO123/chats?page=1&pageSize=100',
    'instância e token no path, paginação na query',
  );
  assert.strictEqual(chamadas[0].method, 'GET');
  assert.strictEqual(chamadas[0].headers['client-token'], 'CLIENT123');
  assert.ok(r.completo);
  assert.strictEqual(r.chats.length, 1);

  // nome e anotação morrem na fronteira do provider: o resto do sistema nunca vê
  assert.deepStrictEqual(
    Object.keys(r.chats[0]).sort(),
    ['isGroup', 'lid', 'phone', 'semData'].sort(),
    'o chat reduzido só tem identificador, se é grupo e se veio sem data',
  );

  // ── contato com número oculto: vem SEM phone, só com lid ───────────────────
  // No aparelho da Bruna isso é mais da metade das conversas. A doc do /chats não
  // lista o campo `lid`, mas a API devolve — e sem ele metade dos pacientes
  // antigos ficaria de fora da lista.
  instalarFetchFalso();
  respostas.push({
    json: [
      { ...chat(''), lid: '888888888888888@lid', phone: undefined },
      { ...chat('5527999990001'), lid: '777777777777777@lid' },
    ],
  });
  respostas.push({ json: [] });
  r = await coletarChats({ pageSize: 100 });
  assert.strictEqual(r.chats[0].phone, '', 'contato oculto não tem telefone');
  assert.strictEqual(r.chats[0].lid, '888888888888888', 'mas tem lid, já normalizado pra dígitos');
  assert.strictEqual(r.chats[1].phone, '5527999990001');
  assert.strictEqual(r.chats[1].lid, '777777777777777', 'quem tem os dois preserva os dois');

  // ── paginação: NUNCA parar por página curta ─────────────────────────────────
  // A doc não fixa teto de pageSize. Se a API devolver 50 pra um pedido de 100,
  // "página curta encerra" pararia na página 1 e daria a lista por completa — o
  // pior resultado possível, porque o operador libera a IA achando que importou tudo.
  instalarFetchFalso();
  respostas.push({ json: [chat('5527999990001'), chat('5527999990002')] }); // curta
  respostas.push({ json: [chat('5527999990003')] });
  respostas.push({ json: [] });
  r = await coletarChats({ pageSize: 100 });
  assert.strictEqual(r.chats.length, 3, 'seguiu depois da página curta');
  assert.strictEqual(r.paginas, 2);
  assert.ok(r.completo);

  // ── paginação: para quando a API ignora o `page` e repete ───────────────────
  instalarFetchFalso();
  respostas.push({ json: [chat('5527999990001')] });
  respostas.push({ json: [chat('5527999990001')] }); // mesma página de novo
  r = await coletarChats({ pageSize: 100, maxPaginas: 50 });
  assert.strictEqual(r.chats.length, 1, 'não duplica quando a API repete a página');
  assert.strictEqual(chamadas.length, 2, 'e para de pedir');

  // ── teto de páginas ────────────────────────────────────────────────────────
  instalarFetchFalso();
  for (let i = 0; i < 10; i++) respostas.push({ json: [chat(`552799999000${i}`)] });
  r = await coletarChats({ pageSize: 1, maxPaginas: 3 });
  assert.strictEqual(chamadas.length, 3, 'respeita maxPaginas');
  assert.ok(r.completo);

  // ── falha: lista parcial NUNCA se apresenta como completa ───────────────────
  instalarFetchFalso();
  respostas.push({ json: [chat('5527999990001')] });
  respostas.push({ ok: false, status: 500, json: { error: 'boom' } });
  respostas.push({ ok: false, status: 500, json: { error: 'boom' } });
  respostas.push({ ok: false, status: 500, json: { error: 'boom' } });
  r = await coletarChats({ pageSize: 100, tentativas: 3 });
  assert.strictEqual(r.completo, false, 'página que falhou derruba o "completo"');
  assert.strictEqual(r.chats.length, 1, 'devolve o que conseguiu, mas avisa');
  assert.strictEqual(chamadas.length, 4, '1 página boa + 3 tentativas na que falhou');

  // ── o erro não pode carregar o token nem a URL ──────────────────────────────
  // O ZAPI_INSTANCE_TOKEN vive DENTRO do path: quem o tem envia WhatsApp como a
  // clínica. Num log do Railway ele é pior que qualquer telefone.
  const erro = r.erro ?? '';
  assert.ok(erro.length > 0, 'o motivo da falha é reportado');
  assert.ok(!erro.includes('TOKFALSO123'), 'o token NÃO aparece na mensagem de erro');
  assert.ok(!erro.includes('api.z-api.io'), 'nem a URL (que contém o token)');
  assert.ok(!erro.includes('INST123'), 'nem o id da instância');

  // falha de REDE (fetch rejeita) — o caminho em que a `cause` da undici costuma
  // carregar a URL inteira
  instalarFetchFalso();
  globalThis.fetch = (async () => {
    throw new Error('connect ECONNREFUSED https://api.z-api.io/instances/INST123/token/TOKFALSO123/chats');
  }) as typeof fetch;
  r = await coletarChats({ pageSize: 100, tentativas: 1 });
  assert.strictEqual(r.completo, false);
  assert.ok(r.erro, 'erro de rede também é reportado');

  // ── grupo e chat sem data continuam vindo, marcados ────────────────────────
  // `archived` de propósito NÃO filtra: chat arquivado é o legado que mais precisa
  // ficar mudo. E chat sem lastMessageTime (428 dos 720 no aparelho da Bruna) não
  // pode ser descartado — só contado.
  instalarFetchFalso();
  respostas.push({
    json: [
      chat('120363019502650977', { isGroup: true }),
      chat('5527999990004', { lastMessageTime: null }),
      chat('5527999990005', { archived: 'true' }),
    ],
  });
  respostas.push({ json: [] });
  r = await coletarChats({ pageSize: 100 });
  assert.strictEqual(r.chats.length, 3);
  assert.ok(r.chats[0].isGroup);
  assert.ok(r.chats[1].semData, 'sem lastMessageTime é sinalizado, não descartado');
  assert.ok(!r.chats[2].semData);

  console.log('✓ test-zapi-chats: OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
