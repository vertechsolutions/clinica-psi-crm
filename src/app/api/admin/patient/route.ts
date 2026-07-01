import { isAdmin } from '@/lib/auth';
import { hasDb } from '@/lib/db';
import { deletePatientData } from '@/lib/maintenance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Exclusão dos dados de um paciente por número (LGPD Art. 18 VI — direito ao
 * apagamento). Uso: DELETE /api/admin/patient?waId=5549999999999
 * Apaga o histórico de conversa e a ficha daquele número. Só admin.
 */
export async function DELETE(req: Request): Promise<Response> {
  if (!isAdmin(req)) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasDb) return Response.json({ error: 'Sem banco configurado' }, { status: 503 });

  const waId = new URL(req.url).searchParams.get('waId')?.trim();
  if (!waId) return Response.json({ error: 'informe ?waId=<numero>' }, { status: 400 });

  try {
    const r = await deletePatientData(waId);
    // loga só a contagem — nunca o número em claro (minimização em logs)
    console.log(`[admin] apagados dados de 1 paciente: ${r.conversas} conversa(s), ${r.mensagens} mensagem(ns)`);
    return Response.json({ ok: true, ...r });
  } catch (err) {
    console.error('[admin] exclusão falhou', err);
    return Response.json({ error: 'falha ao excluir' }, { status: 500 });
  }
}
