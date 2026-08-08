/**
 * O boot de verdade — tudo que só existe no runtime Node (driver do Postgres,
 * google-auth-library, timers de cron).
 *
 * Vive num arquivo SEPARADO porque o Next chama `register()` em TODOS os
 * ambientes e compila o `instrumentation` para cada runtime. Um
 * `if (NEXT_RUNTIME !== 'nodejs') return` guarda a EXECUÇÃO, mas não o grafo de
 * módulos: `pg` e `google-auth-library` continuavam entrando no bundle não-Node,
 * onde `require('http')` e `pg-native` não existem. O import condicional de um
 * módulo à parte é o padrão documentado para isso —
 * `next/dist/docs/01-app/02-guides/instrumentation.md:70-96`
 * ("Importing runtime-specific code").
 *
 * Honestidade sobre o histórico: o que de fato derrubava TODA rota com 500 em
 * `next dev` era o bundler legado (`--webpack`), e o conserto foi voltar ao
 * Turbopack (o default do Next 16). Esta separação sozinha NÃO resolvia aquilo —
 * ela existe para o app parar de violar a regra da doc, e para que o dia em que
 * alguém acrescentar um `proxy.ts` ou um middleware não traga o problema de volta.
 */
export async function registerNode(): Promise<void> {
  // avisos de configuração que afetam a segurança do webhook. Ambos os providers
  // são fail-closed: sem o segredo, o webhook recusa TODA mensagem.
  const provider = (process.env.WA_PROVIDER || 'zapi').trim().toLowerCase();
  if (process.env.NODE_ENV === 'production') {
    console.log(`[boot] transporte WhatsApp: ${provider}`);
    if (provider === 'meta' && !process.env.WHATSAPP_APP_SECRET)
      console.error('[boot] WHATSAPP_APP_SECRET ausente — o webhook vai RECUSAR mensagens até configurar.');
    if (provider !== 'meta') {
      if (!process.env.ZAPI_WEBHOOK_SECRET)
        console.error('[boot] ZAPI_WEBHOOK_SECRET ausente — o webhook vai RECUSAR mensagens até configurar.');
      if (!process.env.ZAPI_INSTANCE_ID || !process.env.ZAPI_INSTANCE_TOKEN)
        console.error('[boot] ZAPI_INSTANCE_ID/ZAPI_INSTANCE_TOKEN ausentes — a Camila não consegue responder.');
    }
    if (!process.env.ADMIN_API_KEY)
      console.error('[boot] ADMIN_API_KEY ausente — os endpoints admin vão recusar acesso.');
  }

  if (!process.env.DATABASE_URL) {
    console.warn('[boot] DATABASE_URL ausente — schema não inicializado (webhook do WhatsApp inativo).');
    return;
  }
  try {
    const { initSchema } = await import('@/lib/schema');
    await initSchema();
    console.log('[boot] schema Postgres pronto.');
    const { scheduleCleanup } = await import('@/lib/maintenance');
    scheduleCleanup();
    const { scheduleFollowup } = await import('@/lib/followup');
    scheduleFollowup();

    await registrarDesligamento();

    // Rede de segurança do debounce: responde quem ficou falando sozinho quando
    // o processo anterior morreu dentro da janela de 8s.
    //
    // FIRE-AND-FORGET de propósito: a varredura é sequencial e cada turno custa
    // dezenas de segundos de Gemini. Aguardá-la aqui seguraria o `register()`,
    // que a doc do Next diz que "must complete before the server is ready to
    // handle requests" (`instrumentation.md:19`) — ou seja, o health check do
    // Railway estouraria e o deploy que a varredura existe pra consertar seria
    // justamente o que ela derrubaria.
    //
    // `varrerPendentes` não lança; o `.catch` é a segunda rede, porque uma
    // promise rejeitada sem handler derruba o processo no Node moderno.
    const { varrerPendentes } = await import('@/lib/boot-sweep');
    void varrerPendentes().catch((err) => console.error('[boot] varredura de pendentes falhou', err));
  } catch (err) {
    console.error('[boot] falha ao inicializar o schema:', err);
  }
}

/**
 * Desligamento gracioso: no SIGTERM/SIGINT, cancela as janelas de debounce que
 * ainda não dispararam.
 *
 * Por que isto existe: numa parada, o Next para de aceitar conexões e ESPERA as
 * requisições em voo e os `after()` pendentes antes de sair
 * (`02-guides/self-hosting.md:299`, e `server/lib/start-server.js:322-390`, que
 * fecha o servidor, roda os listeners e só então dá `process.exit(143)`). Cada
 * janela aberta é um `after()` parado esperando 8s de silêncio — sem cancelar,
 * o shutdown arrasta esse tempo à toa e o Railway acaba mandando SIGKILL.
 *
 * O custo, que precisa estar escrito: cancelar RESOLVE as promises daqueles
 * `after()`, e as mensagens que estavam naquelas janelas ficam sem resposta até
 * o próximo boot. É exatamente por isso que este handler e a varredura de
 * pendentes andam juntos — um cria a dívida, a outra paga.
 *
 * Detalhes que não são óbvios:
 *  · nada de `process.exit()` aqui. Quem encerra é o Next, DEPOIS de drenar; um
 *    exit nosso mataria os turnos que já estão gerando resposta — os mesmos que
 *    o drain existe para salvar.
 *  · `NEXT_MANUAL_SIG_HANDLE` liga o modo manual e o Next deixa de registrar
 *    handler nenhum (`start-server.js:387`). Aí um `process.on` nosso passaria a
 *    SUBSTITUIR o comportamento padrão do Node (terminar) sem pôr nada no lugar,
 *    e o processo só morreria no SIGKILL. Nesse modo saímos fora.
 *  · o `register()` roda uma vez por instância de servidor (`instrumentation.md:19`),
 *    então o handler não duplica em produção. O flag em `globalThis` é a rede
 *    contra o hot-reload do `next dev`, que reexecuta o módulo — mesmo motivo do
 *    pool em `db.ts` e da agenda em `turno.ts`.
 */
async function registrarDesligamento(): Promise<void> {
  const g = globalThis as unknown as { __clinicaSinaisRegistrados?: boolean };
  if (g.__clinicaSinaisRegistrados) return;
  if (process.env.NEXT_MANUAL_SIG_HANDLE) {
    console.warn('[boot] NEXT_MANUAL_SIG_HANDLE ligado — janelas de turno não serão canceladas no shutdown.');
    return;
  }
  // Import EAGER, e não dentro do handler: o `cancelarJanelas` precisa rodar de
  // forma síncrona quando o sinal chega, senão o Next pode terminar o drain
  // antes de um `await import()` resolver — e o cancelamento perderia a corrida
  // justamente contra o que ele existe para encurtar.
  const { cancelarJanelas } = await import('@/lib/turno');
  g.__clinicaSinaisRegistrados = true;

  const encerrar = (sinal: string) => {
    try {
      const n = cancelarJanelas();
      if (n > 0)
        console.log(
          `[boot] ${sinal}: ${n} janela(s) de turno cancelada(s) — essas mensagens ficam para a varredura do próximo boot.`,
        );
    } catch (err) {
      console.error('[boot] falha ao cancelar as janelas de turno no shutdown', err);
    }
  };
  process.once('SIGTERM', () => encerrar('SIGTERM'));
  process.once('SIGINT', () => encerrar('SIGINT'));
}
