/**
 * Roda uma vez quando o servidor Next sobe (antes de aceitar requests). Cria o
 * schema do Postgres e agenda a limpeza de dados (LGPD). Gate em
 * NEXT_RUNTIME==='nodejs' + import dinâmico pra não carregar o driver pg no
 * Edge/cliente. Se não houver DATABASE_URL, o app sobe mesmo assim (a tela de
 * teste funciona sem banco; só o webhook do WhatsApp precisa de DB).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // avisos de configuração que afetam a segurança do webhook
  if (process.env.NODE_ENV === 'production') {
    if (!process.env.WHATSAPP_APP_SECRET)
      console.error('[boot] WHATSAPP_APP_SECRET ausente — o webhook vai RECUSAR mensagens até configurar.');
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
  } catch (err) {
    console.error('[boot] falha ao inicializar o schema:', err);
  }
}
