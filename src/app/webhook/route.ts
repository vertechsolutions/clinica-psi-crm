// Alias curto do webhook: `/webhook` cai no mesmo handler de
// `/api/whatsapp/webhook` (URLs antigas coladas no painel continuam funcionando).
//
// `runtime`/`dynamic` são declarados AQUI e não re-exportados: o analisador
// estático do Next não enxerga valor vindo de re-export e cai no default em
// silêncio — hoje daria no mesmo, mas silenciaria qualquer config futura.
export { GET, POST } from '@/app/api/whatsapp/webhook/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
