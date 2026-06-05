'use client';
import { useKanban } from '@/stores/kanban-store';
import { fmtData, fmtDiaSemana } from '@/lib/datetime';
import { Avatar } from '../avatar';

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
      className="fade-in fixed inset-0 z-50 flex items-center justify-center bg-navy/50 p-4 backdrop-blur-sm"
      onClick={close}
    >
      <div
        className="pop-in w-full max-w-md rounded-2xl bg-surface p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3">
          <Avatar src={psi.foto} iniciais={psi.iniciais} cor={psi.cor} size={44} />
          <div className="min-w-0">
            <div className="text-base font-semibold text-navy">{psi.nome}</div>
            <div className="truncate text-xs text-ink-muted">{psi.especialidade} · escolha o horário</div>
          </div>
          <button onClick={close} className="ml-auto text-2xl leading-none text-ink-muted hover:text-navy">
            ×
          </button>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-2.5">
          {psi.agenda.length === 0 && (
            <p className="col-span-2 rounded-xl bg-surface-2 p-4 text-center text-sm text-ink-muted">
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
                className="group rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-left transition-all hover:-translate-y-0.5 hover:border-cyan-dark hover:bg-cyan/5 hover:shadow-sm"
              >
                <div className="text-sm font-semibold text-navy group-hover:text-cyan-dark">
                  {fmtDiaSemana(slot.iso)}
                </div>
                <div className="text-xs text-ink-muted">{fmtData(slot.iso)}</div>
              </button>
            ))}
        </div>

        <button
          onClick={close}
          className="mt-5 w-full rounded-xl py-2.5 text-sm text-ink-muted transition-colors hover:bg-surface-2 hover:text-navy"
        >
          Cancelar
        </button>
      </div>
    </div>
  );
}
