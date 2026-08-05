/**
 * Testes do transporte (sem rede): autenticação do webhook e normalização do
 * payload dos dois providers. É aqui que se pega o erro que só apareceria com a
 * Bruna já pareada — payload lido errado, eco confundido com paciente, webhook
 * aberto pra qualquer um.
 *
 * Rodar:  npx tsx scripts/test-wa-provider.ts
 */
import assert from 'node:assert';

// as envs precisam existir ANTES do import dos providers (são lidas no módulo)
process.env.ZAPI_INSTANCE_ID = 'INST123';
process.env.ZAPI_INSTANCE_TOKEN = 'TOK123';
process.env.ZAPI_WEBHOOK_SECRET = 'segredo-do-webhook';
process.env.WHATSAPP_APP_SECRET = 'app-secret-meta';

// import estático não serve: os módulos leem process.env na carga, e as envs
// acima precisam já estar de pé (o tsx roda em CJS, sem top-level await).
async function main() {
const { zapiProvider } = await import('../src/lib/wa/zapi');
const { metaProvider } = await import('../src/lib/wa/meta');
const { normalizarWaId } = await import('../src/lib/wa/types');

const req = (u: string, headers: Record<string, string> = {}) => ({
  url: new URL(u),
  headers: new Headers(headers),
});
const URL_OK = 'https://app.exemplo.com/api/whatsapp/webhook?s=segredo-do-webhook';
const URL_SEM = 'https://app.exemplo.com/api/whatsapp/webhook';

// ── autenticação (Z-API não assina: a porta é o segredo na URL/header) ────────
assert.strictEqual(zapiProvider.autenticar('{}', req(URL_OK)), true, 'segredo na query abre');
assert.strictEqual(
  zapiProvider.autenticar('{}', req(URL_SEM, { 'x-webhook-secret': 'segredo-do-webhook' })),
  true,
  'segredo no header abre',
);
assert.strictEqual(zapiProvider.autenticar('{}', req(URL_SEM)), false, 'sem segredo → 401');
assert.strictEqual(
  zapiProvider.autenticar('{}', req('https://app.exemplo.com/w?s=errado')),
  false,
  'segredo errado → 401',
);
// prefixo do segredo não pode passar (comparação é de igualdade, não startsWith)
assert.strictEqual(zapiProvider.autenticar('{}', req('https://app.exemplo.com/w?s=segredo')), false);

// a Z-API não faz handshake por GET
assert.strictEqual(zapiProvider.verifyChallenge(new URL(URL_OK)), null);

// ── parse: texto do paciente ──────────────────────────────────────────────────
const texto = zapiProvider.parse(
  JSON.stringify({
    phone: '5527988420050',
    fromMe: false,
    messageId: '3EB0C767D097B7C7AA0B',
    senderName: 'Helena',
    momment: 1754300000000,
    isGroup: false,
    instanceId: 'INST123',
    text: { message: '  oi, queria marcar uma sessão  ' },
  }),
)[0];
assert.ok(texto, 'mensagem de texto é parseada');
assert.strictEqual(texto.waId, '5527988420050');
assert.strictEqual(texto.messageId, '3EB0C767D097B7C7AA0B');
assert.strictEqual(texto.tipo, 'text');
assert.strictEqual(texto.texto, 'oi, queria marcar uma sessão', 'trim aplicado');
assert.strictEqual(texto.nome, 'Helena');
assert.strictEqual(texto.fromMe, false);

// ── parse: áudio e comprovante vêm com URL direta (um hop, sem Bearer) ────────
const audio = zapiProvider.parse(
  JSON.stringify({
    phone: '+55 (27) 98842-0050',
    messageId: 'A1',
    audio: { audioUrl: 'https://cdn.z-api.io/a.ogg', mimeType: 'audio/ogg; codecs=opus' },
  }),
)[0];
assert.strictEqual(audio.tipo, 'audio');
assert.strictEqual(audio.midia?.url, 'https://cdn.z-api.io/a.ogg');
assert.strictEqual(audio.waId, '5527988420050', 'telefone formatado vira só dígitos');

const img = zapiProvider.parse(
  JSON.stringify({
    phone: '5527988420050',
    messageId: 'A2',
    image: { imageUrl: 'https://cdn.z-api.io/i.jpg', caption: 'comprovante', mimeType: 'image/jpeg' },
  }),
)[0];
assert.strictEqual(img.tipo, 'image');
assert.strictEqual(img.legenda, 'comprovante');
assert.strictEqual(img.midia?.mimeType, 'image/jpeg');

// tipo sem tratamento entra no histórico com o rótulo cru
const fig = zapiProvider.parse(JSON.stringify({ phone: '5527988420050', messageId: 'A3', sticker: {} }))[0];
assert.strictEqual(fig.tipo, 'outro');
assert.strictEqual(fig.tipoCru, 'sticker');

// ── parse: o que NÃO pode virar turno da IA ───────────────────────────────────
assert.deepStrictEqual(
  zapiProvider.parse(JSON.stringify({ phone: '5527988420050', messageId: 'G1', isGroup: true, text: { message: 'oi' } })),
  [],
  'grupo é ignorado',
);
// Recibo de entrega: vem COM phone e messageId, mas sem conteúdo nenhum. Se
// passar, entra no histórico como fala do paciente e a Camila responde "me
// manda por texto" pra cada mensagem que ela própria enviou.
assert.deepStrictEqual(
  zapiProvider.parse(
    JSON.stringify({
      type: 'DeliveryCallback',
      phone: '5527988420050',
      messageId: 'D1',
      zaapId: 'Z1',
      status: 'SENT',
      momment: 1754300000000,
    }),
  ),
  [],
  'recibo de entrega é ignorado',
);
assert.deepStrictEqual(
  zapiProvider.parse(
    JSON.stringify({ type: 'MessageStatusCallback', phone: '5527988420050', ids: ['D1'], status: 'READ' }),
  ),
  [],
  'mudança de status é ignorada',
);
assert.deepStrictEqual(
  zapiProvider.parse(JSON.stringify({ type: 'DisconnectedCallback', connected: false })),
  [],
  'aviso de desconexão é ignorado',
);
assert.deepStrictEqual(zapiProvider.parse('não é json'), [], 'json inválido não derruba o webhook');
// Identificadores que NÃO são uma pessoa. Enquanto a WA_ALLOWLIST está preenchida
// isto fica escondido (`atende('')` é false só porque a lista tem números);
// esvaziá-la abriria caminho pra status@broadcast virar uma "conversa" de wa_id
// vazio, juntando o status de todo mundo, chamando o Gemini e tentando responder.
for (const phone of ['status@broadcast', '120363019502650977-group', '120363019502650977@g.us', '123456789@newsletter']) {
  assert.deepStrictEqual(
    zapiProvider.parse(JSON.stringify({ phone, messageId: 'B1', text: { message: 'oi' } })),
    [],
    `${phone} não é conversa individual`,
  );
}
assert.deepStrictEqual(
  zapiProvider.parse(
    JSON.stringify({ phone: '5527988420050', messageId: 'N1', isNewsletter: true, text: { message: 'oi' } }),
  ),
  [],
  'canal (newsletter) é ignorado mesmo vindo com telefone',
);
assert.deepStrictEqual(
  zapiProvider.parse(JSON.stringify({ phone: '12345', messageId: 'C1', text: { message: 'oi' } })),
  [],
  'telefone curto demais não é gente',
);

// Contato que ligou a privacidade de número: o "telefone" que chega é um
// identificador anônimo. Mais da METADE das conversas antigas da Bruna é assim, e
// a lista de legado guarda o lid junto — por isso ele precisa sobreviver ao parse,
// normalizado em dígitos pra casar com o que veio do /chats.
const comLid = zapiProvider.parse(
  JSON.stringify({
    phone: '999999999999999@lid',
    chatLid: '999999999999999@lid',
    messageId: 'L1',
    text: { message: 'oi' },
  }),
)[0];
assert.strictEqual(comLid.waId, '999999999999999');
assert.strictEqual(comLid.lid, '999999999999999', 'lid preservado e normalizado');

// com telefone E lid: guarda os dois, porque a mesma pessoa pode ter entrado na
// lista por um deles e chegar aqui pelo outro
const ambos = zapiProvider.parse(
  JSON.stringify({
    phone: '5527988420050',
    messageId: 'L2',
    senderLid: '888888888888@lid',
    text: { message: 'oi' },
  }),
)[0];
assert.strictEqual(ambos.waId, '5527988420050');
assert.strictEqual(ambos.lid, '888888888888');

const semLid = zapiProvider.parse(
  JSON.stringify({ phone: '5527988420050', messageId: 'L3', text: { message: 'oi' } }),
)[0];
assert.strictEqual(semLid.lid, undefined, 'sem lid no payload, sem lid na mensagem');
assert.deepStrictEqual(
  zapiProvider.parse(JSON.stringify({ phone: '55279', messageId: 'X', instanceId: 'OUTRA', text: { message: 'oi' } })),
  [],
  'evento de outra instância é ignorado',
);

// ── eco: o que sai do número volta com fromMe=true ────────────────────────────
const eco = zapiProvider.parse(
  JSON.stringify({ phone: '5527988420050', fromMe: true, messageId: 'E1', text: { message: 'oi, aqui é a Bruna' } }),
)[0];
assert.strictEqual(eco.fromMe, true, 'eco preserva fromMe — o webhook decide se é a Camila ou a Bruna');
assert.strictEqual(eco.texto, 'oi, aqui é a Bruna');

// ── Meta: segue funcionando (rollback é trocar WA_PROVIDER) ───────────────────
const metaMsg = metaProvider.parse(
  JSON.stringify({
    entry: [
      {
        changes: [
          {
            value: {
              contacts: [{ profile: { name: 'Carlos' } }],
              messages: [{ from: '5549999551051', id: 'wamid.HBg', type: 'text', text: { body: 'oi' } }],
            },
          },
        ],
      },
    ],
  }),
)[0];
assert.strictEqual(metaMsg.waId, '5549999551051');
assert.strictEqual(metaMsg.texto, 'oi');
assert.strictEqual(metaMsg.nome, 'Carlos');
assert.strictEqual(metaMsg.fromMe, false, 'a Cloud API nunca ecoa envio da clínica');
assert.strictEqual(metaProvider.autenticar('{}', req(URL_SEM)), false, 'Meta sem assinatura → 401');

// ── normalização de número ────────────────────────────────────────────────────
assert.strictEqual(normalizarWaId('+55 27 98842-0050'), '5527988420050');
assert.strictEqual(normalizarWaId('5527988420050@c.us'), '5527988420050');
assert.strictEqual(normalizarWaId(''), '');

console.log('test-wa-provider: todos os asserts passaram ✔');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
