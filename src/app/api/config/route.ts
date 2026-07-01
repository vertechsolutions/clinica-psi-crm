import { getActivePrompt, setActivePrompt } from '@/lib/conversation';
import { hasDb } from '@/lib/db';
import { isAdmin } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET → o raciocínio ativo (o que o webhook do WhatsApp está usando). Protegido:
 * o prompt revela a lógica interna do bot (campos coletados, tratamento de crise),
 * então só admin lê. Sem banco, devolve nada — a tela cai no DEFAULT local.
 */
export async function GET(req: Request): Promise<Response> {
  if (!isAdmin(req)) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasDb) return Response.json({ prompt: null, persisted: false });
  try {
    const prompt = await getActivePrompt();
    return Response.json({ prompt, persisted: true });
  } catch (err) {
    console.error('[config] GET falhou', err);
    return Response.json({ prompt: null, persisted: false });
  }
}

/**
 * POST → salva o raciocínio ativo (a calibração da tela vira o comportamento do
 * WhatsApp). Protegido: reescrever esse prompt muda como o bot lida com pacientes
 * em crise, então exige a chave de admin. Requer Postgres.
 */
export async function POST(req: Request): Promise<Response> {
  if (!isAdmin(req)) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasDb) {
    return Response.json({ error: 'Sem banco configurado — não é possível salvar no servidor.' }, { status: 503 });
  }
  let prompt: unknown;
  try {
    ({ prompt } = (await req.json()) as { prompt?: unknown });
  } catch {
    return Response.json({ error: 'JSON inválido' }, { status: 400 });
  }
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return Response.json({ error: 'prompt vazio' }, { status: 400 });
  }
  try {
    await setActivePrompt(prompt);
    return Response.json({ ok: true });
  } catch (err) {
    console.error('[config] POST falhou', err);
    return Response.json({ error: 'falha ao salvar' }, { status: 500 });
  }
}
