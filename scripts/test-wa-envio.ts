/**
 * Testes do lado de SAÍDA do transporte, com `fetch` falso — nada sai pra rede.
 * O `test-wa-provider.ts` cobre a leitura (autenticação + parse do webhook); aqui
 * é o que a Camila FALA: url, headers, corpo, o id devolvido (que é o que impede
 * o eco da própria resposta de pausar a conversa) e o comportamento em falha.
 *
 * Rodar:  npx tsx scripts/test-wa-envio.ts
 */
import assert from 'node:assert';

process.env.ZAPI_INSTANCE_ID = 'INST123';
process.env.ZAPI_INSTANCE_TOKEN = 'TOK123';
process.env.ZAPI_CLIENT_TOKEN = 'CLIENT123';
process.env.ZAPI_WEBHOOK_SECRET = 'segredo';
process.env.WHATSAPP_TOKEN = 'meta-token';
process.env.WHATSAPP_PHONE_NUMBER_ID = '55555';
process.env.WA_PROVIDER = 'zapi';

interface Chamada {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

const chamadas: Chamada[] = [];
/** resposta por chamada; quando acaba, cai no default 200 {} */
let respostas: Array<{ ok?: boolean; status?: number; json?: unknown; buf?: ArrayBuffer; headers?: Record<string, string> }> = [];

function instalarFetchFalso() {
  chamadas.length = 0;
  respostas = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    chamadas.push({
      url: String(input),
      method: init?.method || 'GET',
      headers,
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
    });
    const r = respostas.shift() || {};
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: async () => r.json ?? {},
      arrayBuffer: async () => r.buf ?? new ArrayBuffer(0),
      headers: new Headers(r.headers ?? {}),
    } as unknown as Response;
  }) as typeof fetch;
}

async function main() {
  const { zapiProvider } = await import('../src/lib/wa/zapi');
  const { metaProvider } = await import('../src/lib/wa/meta');
  const wa = await import('../src/lib/whatsapp');

  // ── Z-API: envio de texto ───────────────────────────────────────────────────
  instalarFetchFalso();
  respostas.push({ json: { zaapId: 'Z1', messageId: 'M1', id: 'M1' } });
  const id = await zapiProvider.sendText('+55 (27) 98842-0050', 'oi, tudo bem?');

  assert.strictEqual(id, 'M1', 'devolve o messageId — sem ele o eco vira "a Bruna assumiu"');
  assert.strictEqual(chamadas.length, 1);
  const envio = chamadas[0];
  assert.strictEqual(
    envio.url,
    'https://api.z-api.io/instances/INST123/token/TOK123/send-text',
    'instância e token vão no PATH, não em header',
  );
  assert.strictEqual(envio.method, 'POST');
  assert.strictEqual(envio.headers['client-token'], 'CLIENT123', 'Client-Token é a trava da conta');
  assert.strictEqual(envio.headers['content-type'], 'application/json');
  assert.strictEqual(envio.body?.phone, '5527988420050', 'telefone normalizado (só dígitos)');
  assert.strictEqual(envio.body?.message, 'oi, tudo bem?');
  assert.ok(typeof envio.body?.delayTyping === 'number', 'delayTyping liga o "digitando"');

  // erro HTTP: lança, mas o corpo cru (com telefone do paciente) NÃO vaza na mensagem
  instalarFetchFalso();
  respostas.push({ ok: false, status: 401, json: { error: 'invalid token', phone: '5527988420050' } });
  await assert.rejects(
    () => zapiProvider.sendText('5527988420050', 'oi'),
    (e: Error) => {
      assert.ok(/401/.test(e.message), 'status no erro');
      assert.ok(!/5527988420050/.test(e.message), 'LGPD: telefone não vai pro log de erro');
      return true;
    },
  );

  // ── Z-API: mídia vem por URL direta (um hop, sem Authorization) ──────────────
  instalarFetchFalso();
  respostas.push({ buf: new TextEncoder().encode('conteudo-do-comprovante').buffer as ArrayBuffer, headers: { 'content-type': 'image/png' } });
  const media = await zapiProvider.downloadMedia({ url: 'https://cdn.z-api.io/i.jpg' });
  assert.ok(media, 'baixou');
  assert.strictEqual(media!.bytes.toString(), 'conteudo-do-comprovante');
  assert.strictEqual(media!.mimeType, 'image/png', 'mimeType cai no content-type quando o payload não traz');
  assert.strictEqual(chamadas.length, 1, 'um hop só (a Meta precisa de dois)');
  assert.ok(!chamadas[0].headers['authorization'], 'URL da Z-API é pública, sem Bearer');

  // mimeType do payload tem prioridade sobre o header
  instalarFetchFalso();
  respostas.push({ buf: new ArrayBuffer(1), headers: { 'content-type': 'application/octet-stream' } });
  const m2 = await zapiProvider.downloadMedia({ url: 'https://cdn/a.ogg', mimeType: 'audio/ogg' });
  assert.strictEqual(m2!.mimeType, 'audio/ogg');

  // falha no download → null (best-effort: o turno continua, a equipe confere)
  instalarFetchFalso();
  respostas.push({ ok: false, status: 404 });
  assert.strictEqual(await zapiProvider.downloadMedia({ url: 'https://cdn/x.jpg' }), null);
  // sem url também é null (nunca lança)
  assert.strictEqual(await zapiProvider.downloadMedia({ id: 'so-id-da-meta' }), null);

  // ── Z-API: marcar lida nunca derruba o fluxo ────────────────────────────────
  // (o path de read-message é o ponto incerto da doc da Z-API — se der 404 em
  // produção, tem que ser silencioso)
  instalarFetchFalso();
  respostas.push({ ok: false, status: 404, json: { error: 'not found' } });
  await zapiProvider.markReadAndType({ waId: '5527988420050', messageId: 'M1' });
  assert.strictEqual(chamadas.length, 1, 'tentou marcar lida');
  assert.ok(chamadas[0].url.endsWith('/read-message'));

  // ── Z-API: template não existe (sem janela de 24h) ──────────────────────────
  await assert.rejects(() => zapiProvider.sendTemplate('5527988420050', 'retomada'), /não se aplica/);

  // ── Meta: caminho de rollback (WA_PROVIDER=meta) segue íntegro ──────────────
  instalarFetchFalso();
  respostas.push({ json: { messages: [{ id: 'wamid.HBgABC' }] } });
  const idMeta = await metaProvider.sendText('5549999551051', 'oi');
  assert.strictEqual(idMeta, 'wamid.HBgABC', 'extrai o id de messages[0].id');
  assert.strictEqual(chamadas[0].url, 'https://graph.facebook.com/v25.0/55555/messages');
  assert.strictEqual(chamadas[0].headers['authorization'], 'Bearer meta-token');
  assert.strictEqual(chamadas[0].body?.messaging_product, 'whatsapp');

  // mídia da Meta: dois hops, ambos com Bearer
  instalarFetchFalso();
  respostas.push({ json: { url: 'https://lookaside.fb/asset', mime_type: 'image/jpeg' } });
  respostas.push({ buf: new TextEncoder().encode('bytes').buffer as ArrayBuffer });
  const mediaMeta = await metaProvider.downloadMedia({ id: 'MEDIA1' });
  assert.strictEqual(chamadas.length, 2, 'resolve a URL assinada e depois baixa');
  assert.strictEqual(chamadas[0].url, 'https://graph.facebook.com/v25.0/MEDIA1');
  assert.strictEqual(chamadas[1].url, 'https://lookaside.fb/asset');
  assert.strictEqual(chamadas[1].headers['authorization'], 'Bearer meta-token');
  assert.strictEqual(mediaMeta!.mimeType, 'image/jpeg');

  // ── Fachada: sequência de bolhas ────────────────────────────────────────────
  // O `onSent` por bolha é o que fecha a corrida do eco: se o id só fosse
  // registrado no fim, o eco da 1ª bolha chegaria antes e a IA se pausaria
  // sozinha achando que a Bruna tinha assumido a conversa.
  instalarFetchFalso();
  respostas.push({ json: { messageId: 'A' } }, { json: { messageId: 'B' } }, { json: { messageId: 'C' } });
  const ordem: string[] = [];
  const ids = await wa.sendTextSequence('5527988420050', ['um', '  ', 'dois', 'tres'], {
    delayMs: 0,
    onSent: (i) => {
      ordem.push(`registrou:${i}`);
    },
  });
  assert.deepStrictEqual(ids, ['A', 'B', 'C'], 'devolve os ids de todas as bolhas');
  assert.deepStrictEqual(ordem, ['registrou:A', 'registrou:B', 'registrou:C'], 'registra cada bolha na hora');
  assert.strictEqual(chamadas.length, 3, 'bolha vazia é pulada, não vira mensagem em branco');
  assert.deepStrictEqual(
    chamadas.map((c) => c.body?.message),
    ['um', 'dois', 'tres'],
    'ordem das bolhas preservada',
  );

  // falha no meio: propaga (o webhook não persiste um turno que não foi entregue)
  instalarFetchFalso();
  respostas.push({ json: { messageId: 'A' } }, { ok: false, status: 500, json: { error: 'boom' } });
  await assert.rejects(() => wa.sendTextSequence('5527988420050', ['um', 'dois'], { delayMs: 0 }));

  // ── Alerta interno: falha não pode derrubar o handoff ───────────────────────
  instalarFetchFalso();
  respostas.push({ ok: false, status: 500, json: { error: 'boom' } });
  const alerta = await wa.sendInternalAlert('5527981178233', 'triagem concluída');
  assert.strictEqual(alerta, null, 'engole o erro e devolve null');

  console.log('test-wa-envio: todos os asserts passaram ✔');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
