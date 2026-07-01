import crypto from 'node:crypto';

/**
 * Autenticação de admin pros endpoints que mexem no comportamento do bot ou nos
 * dados dos pacientes (/api/config, /api/admin/*). Chave estática no header
 * `x-admin-key`, comparada com ADMIN_API_KEY em tempo constante.
 *
 * Fail-closed em produção: sem ADMIN_API_KEY configurada, recusa. Em dev libera
 * (facilita rodar local sem setar segredo).
 */
const ADMIN_KEY = process.env.ADMIN_API_KEY;

export const adminConfigured = Boolean(ADMIN_KEY);

export function isAdmin(req: Request): boolean {
  if (!ADMIN_KEY) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[auth] ADMIN_API_KEY ausente — recusando acesso admin em produção.');
      return false;
    }
    return true; // dev local
  }
  const provided = req.headers.get('x-admin-key');
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(ADMIN_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
