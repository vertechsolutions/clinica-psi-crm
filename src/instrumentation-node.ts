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
  } catch (err) {
    console.error('[boot] falha ao inicializar o schema:', err);
  }
}
