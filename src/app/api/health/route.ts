// Healthcheck do Railway (deploy.healthcheckPath = /api/health).
import { hasDb } from '@/lib/db';
import { statusLegado } from '@/lib/legado';
import { canSend, providerNome } from '@/lib/whatsapp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Além do "ok" que o Railway espera, mostra o que não dá pra ver de fora sem CLI:
 * qual transporte está ativo, se ele tem credencial pra enviar, e o estado da
 * lista de conversas antigas.
 *
 * Esse último é o que importa: `initSchema` é engolido no boot (instrumentation),
 * então um erro só no CREATE TABLE da lista deixaria a Camila muda para 100% dos
 * leads com o healthcheck verde e todos os webhooks respondendo 200. Aqui isso
 * aparece. Não expõe segredo nem telefone — só contagens.
 */
export async function GET(): Promise<Response> {
  const base = {
    status: 'ok',
    service: 'clinica-psi-assistente',
    provider: providerNome,
    canSend,
    db: hasDb,
  };
  if (!hasDb) return Response.json(base, { status: 200 });

  try {
    const l = await statusLegado();
    return Response.json({
      ...base,
      legado: {
        ok: l.chaveOk,
        total: l.total,
        snapshotEm: l.snapshotEm,
        camilaMuda: l.camilaMuda,
        tentativas: l.tentativas,
      },
    });
  } catch (err) {
    console.error('[health] status do legado falhou', err);
    return Response.json({ ...base, legado: { ok: false, erro: 'indisponível' } });
  }
}
