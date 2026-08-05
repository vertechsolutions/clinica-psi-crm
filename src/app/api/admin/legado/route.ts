import { isAdmin } from '@/lib/auth';
import { resumeConversation, pauseConversation } from '@/lib/conversation';
import { hasDb } from '@/lib/db';
import { importarLegado } from '@/lib/importar-legado';
import {
  consultarLegado,
  marcarLegado,
  removerLegado,
  setCamilaMuda,
  statusLegado,
} from '@/lib/legado';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Administração da lista de conversas antigas (legado) — os números que já eram
 * atendidos à mão pela Bruna quando a Camila entrou no WhatsApp profissional dela.
 *
 * Nenhuma resposta daqui devolve telefone: a lista guarda só hash, e o que sai são
 * contagens e o veredito de um número que o operador já conhecia.
 */

const semBanco = () => Response.json({ error: 'Sem banco configurado' }, { status: 503 });
const naoAutorizado = () => Response.json({ error: 'Unauthorized' }, { status: 401 });

/**
 * Situação da lista:  GET /api/admin/legado
 * Diagnóstico de um número:  GET /api/admin/legado?waId=5527999999999
 *   (responde "por que a Camila está muda aqui?")
 */
export async function GET(req: Request): Promise<Response> {
  if (!isAdmin(req)) return naoAutorizado();
  if (!hasDb) return semBanco();

  const waId = new URL(req.url).searchParams.get('waId')?.replace(/\D/g, '');
  try {
    if (waId) return Response.json(await consultarLegado(waId));
    return Response.json(await statusLegado());
  } catch (err) {
    console.error('[admin] consulta de legado falhou', err);
    return Response.json({ error: 'falha ao consultar' }, { status: 500 });
  }
}

/**
 * Importar do celular:  POST { "acao": "importar", "dry": true, "contatos": false }
 *   `dry` (padrão true) só relata. Pra gravar: { "dry": false, "esperado": <total do DRY> }.
 *
 * Marcar um número à mão:  POST { "waId": "5527999999999" }
 *   Além de entrar na lista, PAUSA a conversa: se aquele número já tem ficha, o
 *   follow-up proativo é a segunda porta de saída da IA e o gate do webhook não a
 *   cobre. Sem a pausa, alguém declarado intocável receberia "não tive seu retorno".
 */
export async function POST(req: Request): Promise<Response> {
  if (!isAdmin(req)) return naoAutorizado();
  if (!hasDb) return semBanco();

  let body: { acao?: unknown; waId?: unknown; dry?: unknown; contatos?: unknown; esperado?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: 'JSON inválido' }, { status: 400 });
  }

  if (body.acao === 'importar') {
    try {
      const r = await importarLegado({
        dry: body.dry !== false,
        contatos: body.contatos === true,
        esperado: typeof body.esperado === 'number' ? body.esperado : undefined,
      });
      return Response.json(r, { status: r.erro && !r.gravado && body.dry === false ? 409 : 200 });
    } catch (err) {
      console.error('[admin] import de legado falhou', err);
      return Response.json({ error: 'falha ao importar' }, { status: 500 });
    }
  }

  const waId = typeof body.waId === 'string' ? body.waId.replace(/\D/g, '') : '';
  if (!waId) return Response.json({ error: 'informe waId ou acao:"importar"' }, { status: 400 });

  try {
    await marcarLegado(waId, 'manual');
    await pauseConversation(waId);
    console.log('[admin] número marcado como conversa antiga da equipe.');
    return Response.json({ legado: true, pausada: true });
  } catch (err) {
    console.error('[admin] marcação de legado falhou', err);
    return Response.json({ error: 'falha ao marcar' }, { status: 500 });
  }
}

/**
 * Botão vermelho:  PATCH { "camilaMuda": true }
 * Cala a IA em TODOS os números na hora, sem restart e sem perder webhook — que é
 * o que trocar variável no Railway custaria. `false` religa.
 */
export async function PATCH(req: Request): Promise<Response> {
  if (!isAdmin(req)) return naoAutorizado();
  if (!hasDb) return semBanco();

  let body: { camilaMuda?: unknown };
  try {
    body = (await req.json()) as { camilaMuda?: unknown };
  } catch {
    return Response.json({ error: 'JSON inválido' }, { status: 400 });
  }
  if (typeof body.camilaMuda !== 'boolean') {
    return Response.json({ error: 'informe camilaMuda: true|false' }, { status: 400 });
  }

  try {
    await setCamilaMuda(body.camilaMuda);
    console.warn(`[admin] camila_muda=${body.camilaMuda}`);
    return Response.json({ camilaMuda: body.camilaMuda });
  } catch (err) {
    console.error('[admin] botão vermelho falhou', err);
    return Response.json({ error: 'falha ao aplicar' }, { status: 500 });
  }
}

/**
 * Passar uma conversa antiga pra Camila:  DELETE /api/admin/legado?waId=5527999999999
 *
 * Também retoma a conversa, porque um mesmo número pode estar mudo por dois
 * motivos (lista de legado e pausa) e um comando só tem que resolver os dois. O
 * status vem do `removerLegado`: para número de legado o normal é NÃO existir
 * linha em wa_conversations, e devolver 404 nesse caso faria o comando parecer ter
 * falhado justamente quando funcionou.
 */
export async function DELETE(req: Request): Promise<Response> {
  if (!isAdmin(req)) return naoAutorizado();
  if (!hasDb) return semBanco();

  const waId = new URL(req.url).searchParams.get('waId')?.replace(/\D/g, '');
  if (!waId) return Response.json({ error: 'informe ?waId=<numero>' }, { status: 400 });

  try {
    const saiu = await removerLegado(waId);
    const retomada = await resumeConversation(waId).catch(() => false);
    console.log('[admin] conversa liberada para a IA.');
    return Response.json({ removido: saiu, retomada }, { status: saiu ? 200 : 404 });
  } catch (err) {
    console.error('[admin] liberação de legado falhou', err);
    return Response.json({ error: 'falha ao liberar' }, { status: 500 });
  }
}
