'use client';
import { useKanban } from '@/stores/kanban-store';
import { fmtData, fmtDiaSemana } from '@/lib/datetime';

export function SchedulePopup() {
  const pending = useKanban((s) => s.pending);
  const psicologas = useKanban((s) => s.psicologas);
  const confirm = useKanban((s) => s.confirmSchedule);
  const close = useKanban((s) => s.closeSchedule);
  if (!pending) return null;
  const psi = psicologas.find((p) => p.id === pending.psicologaId);
  if (!psi) return null;

  return (
    <div
      className="fade-in fixed inset-0 z-50 flex items-center justify-center bg-navy/50 p-4"
      onClick={close}
    >
      <div
        className="pop-in w-full max-w-md rounded-2xl bg-surface p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3">
          <div
            className="flex h-10 w-10 items-center justify-center rounded-full text-sm font-bold text-white"
            style={{ background: psi.cor }}
          >
            {psi.iniciais}
          </div>
          <div>
            <div className="text-sm font-semibold text-navy">{psi.nome}</div>
            <div className="text-xs text-ink-muted">Escolha o horário livre</div>
          </div>
          <button onClick={close} className="ml-auto text-xl leading-none text-ink-muted hover:text-navy">
            ×
          </button>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2">
          {psi.agenda.length === 0 && (
            <p className="col-span-2 rounded-lg bg-surface-2 p-3 text-center text-sm text-ink-muted">
              Sem horários livres pra essa psicóloga.
            </p>
          )}
          {psi.agenda
            .slice()
            .sort((a, b) => a.iso.localeCompare(b.iso))
            .map((slot) => (
              <button
                key={slot.id}
                onClick={() => confirm(slot.iso)}
                className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-left text-sm transition-colors hover:border-cyan-dark hover:bg-cyan/10"
              >
                <div className="font-semibold text-navy">{fmtDiaSemana(slot.iso)}</div>
                <div className="text-xs text-ink-muted">{fmtData(slot.iso)}</div>
              </button>
            ))}
        </div>

        <button
          onClick={close}
          className="mt-4 w-full rounded-lg py-2 text-sm text-ink-muted hover:text-navy"
        >
          Cancelar
        </button>
      </div>
    </div>
  );
}
