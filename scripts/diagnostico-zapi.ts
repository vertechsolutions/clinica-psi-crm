/**
 * Diagnóstico da instância Z-API — só LEITURA, não envia mensagem pra ninguém.
 *
 * Responde as perguntas do dia da estreia: a instância está pareada? é o número
 * certo? o webhook aponta pra cá com o segredo certo? o eco `fromMe` está ligado?
 * o aparelho já sincronizou o histórico?
 *
 * Rodar:  npx tsx --env-file=.env.local scripts/diagnostico-zapi.ts
 *
 * LGPD/segredos: não imprime token, nem o ZAPI_WEBHOOK_SECRET (só compara), nem
 * telefone de contato. O número da própria clínica sai inteiro — é ele que a
 * gente precisa conferir.
 */

/** Número que DEVE estar pareado (WhatsApp profissional da Bruna). */
const NUMERO_ESPERADO = process.env.ZAPI_NUMERO_ESPERADO || '5527988420050';
const URL_APP = process.env.APP_URL || 'https://clinica-psi-crm-production.up.railway.app';

let falhas = 0;

function ok(msg: string): void {
  console.log(`  ✔ ${msg}`);
}
function erro(msg: string): void {
  falhas++;
  console.log(`  ✘ ${msg}`);
}
function aviso(msg: string): void {
  console.log(`  ⚠ ${msg}`);
}

function checarEnvs(): boolean {
  console.log('\n[1/4] Credenciais');
  const obrigatorias = ['ZAPI_INSTANCE_ID', 'ZAPI_INSTANCE_TOKEN'];
  const faltando = obrigatorias.filter((k) => !process.env[k]);
  if (faltando.length) {
    erro(`faltando no .env.local: ${faltando.join(', ')}`);
    return false;
  }
  ok('ZAPI_INSTANCE_ID e ZAPI_INSTANCE_TOKEN presentes');
  if (!process.env.ZAPI_CLIENT_TOKEN) {
    aviso('ZAPI_CLIENT_TOKEN ausente — se a trava de segurança estiver ligada no painel, TUDO dá 4xx');
  } else {
    ok('ZAPI_CLIENT_TOKEN presente');
  }
  if (!process.env.ZAPI_WEBHOOK_SECRET) {
    erro('ZAPI_WEBHOOK_SECRET ausente — sem ele o webhook recusa toda requisição (fail-closed)');
  } else {
    ok('ZAPI_WEBHOOK_SECRET presente');
  }
  return true;
}

async function checarConexao(
  zapi: typeof import('../src/lib/wa/zapi'),
): Promise<void> {
  console.log('\n[2/4] Conexão e número pareado');
  try {
    const st = await zapi.statusInstancia();
    if (st?.connected) ok('instância conectada');
    else erro(`instância NÃO conectada${st?.error ? ` — ${st.error}` : ''} (leia o QR code no painel)`);

    if (st?.smartphoneConnected) ok('celular com internet');
    else aviso('celular sem internet no momento — mensagens ficam presas até ele voltar');
  } catch (err) {
    erro(`GET /status falhou: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const dev = await zapi.dadosDispositivo();
    const phone = typeof dev?.phone === 'string' ? dev.phone.replace(/\D/g, '') : '';
    if (!phone) {
      erro('GET /device não devolveu o número pareado');
    } else if (phone === NUMERO_ESPERADO) {
      ok(`número pareado é o esperado: +${phone}`);
    } else {
      erro(`número pareado é +${phone}, mas o esperado é +${NUMERO_ESPERADO} — instância errada!`);
    }
    if (dev?.isBusiness === true) ok('conta WhatsApp Business');
  } catch (err) {
    erro(`GET /device falhou: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function checarWebhook(zapi: typeof import('../src/lib/wa/zapi')): Promise<void> {
  console.log('\n[3/4] Webhook');
  let me: Record<string, unknown> | null = null;
  try {
    me = await zapi.dadosInstancia();
  } catch (err) {
    aviso(`GET /me falhou (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!me) {
    aviso('não deu pra ler a configuração pela API — confira no painel https://app.z-api.io:');
    aviso('  "Ao receber" = ' + `${URL_APP}/api/whatsapp/webhook?s=<ZAPI_WEBHOOK_SECRET>`);
    aviso('  e a opção de receber as mensagens enviadas pelo próprio número LIGADA');
    return;
  }

  const url = typeof me.receivedCallbackUrl === 'string' ? me.receivedCallbackUrl : '';
  if (!url) {
    erro('webhook "ao receber" está VAZIO — nenhuma mensagem chega no CRM');
  } else if (!url.includes('/api/whatsapp/webhook') && !url.includes('/webhook')) {
    erro('webhook "ao receber" aponta pra outro lugar (não é o endpoint do CRM)');
  } else {
    ok('webhook "ao receber" aponta pro CRM');
    // compara o segredo sem NUNCA imprimi-lo
    const segredoNaUrl = new URL(url).searchParams.get('s');
    if (!segredoNaUrl) {
      erro('a URL do webhook está sem o ?s=<segredo> — o CRM vai responder 401 em tudo');
    } else if (segredoNaUrl === process.env.ZAPI_WEBHOOK_SECRET) {
      ok('segredo da URL confere com o ZAPI_WEBHOOK_SECRET local');
    } else {
      erro('o segredo na URL do painel DIVERGE do ZAPI_WEBHOOK_SECRET local (confira também o Railway)');
    }
  }

  if (me.receiveCallbackSentByMe === true) {
    ok('recebe as mensagens enviadas pelo próprio número (é o que pausa a IA quando a Bruna responde)');
  } else {
    erro('receiveCallbackSentByMe DESLIGADO — a Bruna responder pelo celular não vai pausar a Camila');
  }
}

async function checarChats(zapi: typeof import('../src/lib/wa/zapi')): Promise<void> {
  console.log('\n[4/4] Histórico sincronizado no aparelho');
  const r = await zapi.coletarChats({ pageSize: 100, maxPaginas: 100 });
  if (!r.completo) {
    erro(`a coleta parou no meio (${r.erro ?? 'erro desconhecido'}) — ${r.chats.length} chats lidos`);
    return;
  }
  const individuais = r.chats.filter((c) => !c.isGroup);
  const semData = individuais.filter((c) => c.semData).length;
  const doze = individuais.filter((c) => c.phone.replace(/\D/g, '').length === 12).length;

  ok(`${r.chats.length} chats em ${r.paginas} página(s) — ${individuais.length} individuais, ${r.chats.length - individuais.length} grupos`);
  if (individuais.length === 0) {
    erro('nenhum chat individual — o aparelho ainda não sincronizou o histórico (espere e rode de novo)');
  }
  console.log(`    · ${semData} sem lastMessageTime`);
  console.log(`    · ${doze} com 12 dígitos (formato SEM o 9º dígito)`);
  if (doze > 0) {
    aviso('há números nos dois formatos — a lista de legado precisa gravar as duas variantes (já faz)');
  }
}

async function main(): Promise<void> {
  console.log('Diagnóstico da instância Z-API (somente leitura)');
  if (!checarEnvs()) {
    console.log('\nSem credenciais não dá pra continuar.');
    process.exit(1);
  }
  const zapi = await import('../src/lib/wa/zapi');
  await checarConexao(zapi);
  await checarWebhook(zapi);
  await checarChats(zapi);

  console.log(
    falhas === 0
      ? '\n✅ Instância OK.'
      : `\n❌ ${falhas} item(ns) com problema — resolva antes de abrir a Camila pra pacientes reais.`,
  );
  process.exit(falhas === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[diagnostico-zapi] erro inesperado:', err instanceof Error ? err.message : err);
  process.exit(1);
});
