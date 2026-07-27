import { isAdmin } from '@/lib/auth';
import { hasDb, query } from '@/lib/db';
import { deletePatientData } from '@/lib/maintenance';
import { sanitizarCamposFicha } from '@/lib/ficha';
import { type LeadExtraido } from '@/lib/triagem';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ConversaRow {
  nome: string | null;
  lead: Partial<LeadExtraido> | null;
  pronto: boolean;
  pausada: boolean;
  updated_at: Date;
}

/** Resposta comum do GET/PATCH. `lead` pode vir null (conversa sem ficha ainda). */
function fichaJson(row: ConversaRow, mensagens?: number): Record<string, unknown> {
  return {
    nome: row.nome,
    ficha: row.lead ?? {},
    pronto: row.pronto,
    pausada: row.pausada,
    updatedAt: row.updated_at,
    ...(mensagens === undefined ? {} : { mensagens }),
  };
}

/**
 * Consulta a ficha de um paciente. Uso: GET /api/admin/patient?waId=5549999999999
 * Existe porque a Bruna precisa VER o que a Camila anotou antes de corrigir — até
 * aqui o único jeito de mexer na ficha era apagar tudo (DELETE). Só admin: é dado
 * sensível de saúde. Nada da ficha vai pro log, nem o número.
 */
export async function GET(req: Request): Promise<Response> {
  if (!isAdmin(req)) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasDb) return Response.json({ error: 'Sem banco configurado' }, { status: 503 });

  const waId = new URL(req.url).searchParams.get('waId')?.trim();
  if (!waId) return Response.json({ error: 'informe ?waId=<numero>' }, { status: 400 });

  try {
    // count() volta bigint, e o pg entrega bigint como string — daí o Number()
    const { rows } = await query<ConversaRow & { mensagens: string }>(
      `SELECT c.nome, c.lead, c.pronto, c.pausada, c.updated_at,
              (SELECT count(*) FROM wa_messages m WHERE m.wa_id = c.wa_id) AS mensagens
         FROM wa_conversations c
        WHERE c.wa_id = $1`,
      [waId],
    );
    const row = rows[0];
    if (!row) return Response.json({ error: 'paciente não encontrado' }, { status: 404 });
    return Response.json(fichaJson(row, Number(row.mensagens)));
  } catch (err) {
    console.error('[admin] consulta de ficha falhou', err);
    return Response.json({ error: 'falha ao consultar' }, { status: 500 });
  }
}

/**
 * Corrige campos da ficha. Uso: PATCH /api/admin/patient
 *   { "waId": "5549999999999", "campos": { "telefone": "(49) 99999-0000", "email": null } }
 * MESCLA (`lead || $2`) e apaga só o que veio null (`lead - $3`) — nunca substitui
 * a ficha inteira, senão a correção de um campo apagaria os outros 19 (foi
 * exatamente o bug do `lead = EXCLUDED.lead` no upsert). Um UPDATE só, pra não
 * existir janela em que o turno do webhook mescle por cima de meia correção.
 */
export async function PATCH(req: Request): Promise<Response> {
  if (!isAdmin(req)) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasDb) return Response.json({ error: 'Sem banco configurado' }, { status: 503 });

  let body: { waId?: unknown; campos?: unknown };
  try {
    body = (await req.json()) as { waId?: unknown; campos?: unknown };
  } catch {
    return Response.json({ error: 'JSON inválido' }, { status: 400 });
  }
  const waId = typeof body.waId === 'string' ? body.waId.trim() : '';
  if (!waId) return Response.json({ error: 'informe waId' }, { status: 400 });

  const { campos, remover, invalidos } = sanitizarCamposFicha(body.campos);
  // Tudo ou nada: gravar só a parte válida faria a Bruna achar que a correção
  // inteira entrou. Devolve só os NOMES das chaves recusadas — nunca os valores.
  if (invalidos.length) {
    return Response.json({ error: 'campos inválidos ou desconhecidos', invalidos }, { status: 400 });
  }
  const alterados = Object.keys(campos).length;
  if (!alterados && !remover.length) {
    return Response.json({ error: 'nenhum campo válido para atualizar' }, { status: 400 });
  }
  // A coluna `nome` é cópia denormalizada de lead->>'nome' (quem a Camila lê é o
  // JSONB). Só a sincroniza quando o PATCH mexeu no nome — do contrário apagaria
  // um nome que veio do pushName do WhatsApp e nunca existiu na ficha.
  const mexeuNoNome = Object.hasOwn(campos, 'nome') || remover.includes('nome');

  try {
    const { rows } = await query<ConversaRow>(
      // no UPDATE todas as expressões enxergam a linha ANTIGA, então o CASE e o
      // SET de lead calculam a mesma ficha nova. `- '{}'::text[]` não remove nada,
      // então o mesmo SQL serve com ou sem campos a apagar. O updated_at é bumpado
      // de propósito: mexer na ficha é atividade no registro, e reiniciar o relógio
      // de retenção (LGPD) e o de follow-up é o comportamento certo aqui.
      `UPDATE wa_conversations
          SET lead = (COALESCE(lead, '{}'::jsonb) || $2::jsonb) - $3::text[],
              nome = CASE WHEN $4::boolean
                          THEN ((COALESCE(lead, '{}'::jsonb) || $2::jsonb) - $3::text[]) ->> 'nome'
                          ELSE nome END,
              updated_at = now()
        WHERE wa_id = $1
        RETURNING nome, lead, pronto, pausada, updated_at`,
      [waId, JSON.stringify(campos), remover, mexeuNoNome],
    );
    const row = rows[0];
    if (!row) return Response.json({ error: 'paciente não encontrado' }, { status: 404 });
    // loga só as contagens — nem o número nem o conteúdo dos campos (dado de saúde)
    console.log(`[admin] ficha corrigida: ${alterados} campo(s) alterado(s), ${remover.length} removido(s)`);
    return Response.json(fichaJson(row));
  } catch (err) {
    console.error('[admin] correção de ficha falhou', err);
    return Response.json({ error: 'falha ao corrigir' }, { status: 500 });
  }
}

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
