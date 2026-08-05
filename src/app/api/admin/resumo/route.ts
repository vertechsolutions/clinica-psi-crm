import { isAdmin } from '@/lib/auth';
import { hasDb, query } from '@/lib/db';
import { statusLegado } from '@/lib/legado';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Resumo operacional: quem a Camila está atendendo, quem foi calado por ser
 * conversa antiga, e o que aconteceu nas últimas horas.
 *
 * Existe porque o CRM não tem inbox — dava pra consultar UM número, mas não pra
 * responder "alguém falou com a clínica hoje e a IA atendeu?", que é a pergunta
 * do dia seguinte à virada.
 *
 * LGPD: nenhum conteúdo de mensagem, e o número sai mascarado (4 últimos dígitos,
 * mesma regra dos logs) — o suficiente pra equipe reconhecer quem é sem o
 * endpoint virar uma exportação da base.
 */
export async function GET(req: Request): Promise<Response> {
  if (!isAdmin(req)) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasDb) return Response.json({ error: 'Sem banco configurado' }, { status: 503 });

  const horas = Math.min(Number(new URL(req.url).searchParams.get('horas') ?? 24) || 24, 24 * 30);

  try {
    const { rows: totais } = await query<{
      conversas: string;
      novas: string;
      pausadas: string;
      prontas: string;
    }>(
      `SELECT count(*) AS conversas,
              count(*) FILTER (WHERE created_at > now() - ($1 || ' hours')::interval) AS novas,
              count(*) FILTER (WHERE pausada) AS pausadas,
              count(*) FILTER (WHERE pronto)  AS prontas
         FROM wa_conversations`,
      [String(horas)],
    );

    const { rows: msgs } = await query<{ total: string; recentes: string; de_pacientes: string }>(
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE created_at > now() - ($1 || ' hours')::interval) AS recentes,
              count(*) FILTER (WHERE created_at > now() - ($1 || ' hours')::interval
                                 AND role = 'user') AS de_pacientes
         FROM wa_messages`,
      [String(horas)],
    );

    // as conversas mais recentes, pra ver o que está acontecendo agora
    const { rows: ultimas } = await query<{
      wa_id: string;
      nome: string | null;
      pronto: boolean;
      pausada: boolean;
      created_at: Date;
      updated_at: Date;
      mensagens: string;
      respondeu: boolean;
    }>(
      `SELECT c.wa_id, c.nome, c.pronto, c.pausada, c.created_at, c.updated_at,
              (SELECT count(*) FROM wa_messages m WHERE m.wa_id = c.wa_id) AS mensagens,
              EXISTS (SELECT 1 FROM wa_messages m
                       WHERE m.wa_id = c.wa_id AND m.role = 'assistant') AS respondeu
         FROM wa_conversations c
        ORDER BY c.updated_at DESC
        LIMIT 15`,
    );

    const legado = await statusLegado();

    return Response.json({
      janelaHoras: horas,
      atendidos: {
        conversas: Number(totais[0]?.conversas ?? 0),
        novasNaJanela: Number(totais[0]?.novas ?? 0),
        pausadas: Number(totais[0]?.pausadas ?? 0),
        triagensConcluidas: Number(totais[0]?.prontas ?? 0),
      },
      mensagens: {
        total: Number(msgs[0]?.total ?? 0),
        naJanela: Number(msgs[0]?.recentes ?? 0),
        dePacientesNaJanela: Number(msgs[0]?.de_pacientes ?? 0),
      },
      calados: {
        numerosNaLista: legado.total,
        numerosQueTentaram: legado.numerosQueTentaram,
        tentativas: legado.tentativas,
      },
      ultimasConversas: ultimas.map((r) => ({
        numero: `***${r.wa_id.slice(-4)}`,
        nome: r.nome,
        mensagens: Number(r.mensagens),
        camilaRespondeu: r.respondeu,
        triagemConcluida: r.pronto,
        pausada: r.pausada,
        inicio: r.created_at,
        ultimaAtividade: r.updated_at,
      })),
    });
  } catch (err) {
    console.error('[admin] resumo falhou', err);
    return Response.json({ error: 'falha ao consultar' }, { status: 500 });
  }
}
