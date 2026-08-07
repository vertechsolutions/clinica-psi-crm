/**
 * Roda uma vez quando o servidor Next sobe (antes de aceitar requests). Cria o
 * schema do Postgres e agenda a limpeza de dados (LGPD).
 *
 * Este arquivo é de propósito uma casca: o Next compila o `instrumentation` para
 * TODOS os runtimes, e um import de módulo Node-only aqui entra no grafo do
 * bundle não-Node mesmo estando atrás do gate de `NEXT_RUNTIME`. O corpo mora em
 * `instrumentation-node.ts`, importado só quando o runtime é o certo — padrão
 * documentado em `next/dist/docs/01-app/02-guides/instrumentation.md:70-96`.
 *
 * Se não houver DATABASE_URL, o app sobe mesmo assim (a tela de teste funciona
 * sem banco; só o webhook do WhatsApp precisa de DB).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { registerNode } = await import('./instrumentation-node');
  await registerNode();
}
