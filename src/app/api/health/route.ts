// Healthcheck do Railway (deploy.healthcheckPath = /api/health).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json({ status: 'ok', service: 'clinica-psi-assistente' }, { status: 200 });
}
