'use client';
import { useKanban } from '@/stores/kanban-store';
import { fmtData, isPassado } from '@/lib/datetime';

export function ArchivedView() {
  const pacientes = useKanban((s) => s.pacientes);
  const psicologas = useKanban((s) => s.psicologas);
  const arquivados = pacientes
    .filter((c) => isPassado(c.agendamentoIso))
    .sort((a, b) => (b.agendamentoIso ?? '').localeCompare(a.agendamentoIso ?? ''));

  const nomePsi = (id: string | null) => psicologas.find((p) => p.id === id)?.nome ?? 'sem psicóloga';

  return (
    <div className="flex-1 overflow-y-auto p-4">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-muted">
        Arquivados ({arquivados.length})
      </h2>
      {arquivados.length === 0 && (
        <p className="rounded-lg bg-surface p-4 text-sm text-ink-muted">
          Nenhum atendimento passou da data ainda.
        </p>
      )}
      <div className="space-y-2">
        {arquivados.map((c) => (
          <div
            key={c.id}
            className="flex items-center justify-between rounded-lg border border-line bg-surface px-4 py-3"
          >
            <div>
              <div className="text-sm font-semibold text-navy">{c.nome}</div>
              <div className="text-xs text-ink-muted">{c.resumo}</div>
            </div>
            <div className="text-right">
              <div className="text-xs font-medium text-ink">{nomePsi(c.psicologaId)}</div>
              <div className="text-[11px] text-ink-muted">
                {c.agendamentoIso ? fmtData(c.agendamentoIso) : ''}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
