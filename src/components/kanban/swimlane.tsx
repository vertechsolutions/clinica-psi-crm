'use client';
import { useDroppable } from '@dnd-kit/core';
import type { Psicologa, Paciente } from '@/types';
import { isPassado } from '@/lib/datetime';
import { PatientCard } from './patient-card';

export function Swimlane({
  psicologa,
  pacientes,
}: {
  psicologa: Psicologa;
  pacientes: Paciente[];
}) {
  const { setNodeRef, isOver } = useDroppable({ id: psicologa.id });
  const cards = pacientes
    .filter((c) => c.psicologaId === psicologa.id && !isPassado(c.agendamentoIso))
    .sort((a, b) => (a.agendamentoIso ?? '').localeCompare(b.agendamentoIso ?? ''));

  return (
    <div className="flex border-b border-line">
      <div className="flex w-44 shrink-0 items-center gap-2 border-r border-line bg-surface-2 p-3 md:w-48">
        <div
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
          style={{ background: psicologa.cor }}
        >
          {psicologa.iniciais}
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-navy">{psicologa.nome}</div>
          <div className="truncate text-[11px] text-ink-muted">{psicologa.especialidade}</div>
        </div>
        <span className="ml-auto rounded-full bg-navy/5 px-1.5 text-[11px] text-ink-muted">
          {cards.length}
        </span>
      </div>
      <div
        ref={setNodeRef}
        className={`flex min-h-[84px] flex-1 items-center gap-3 overflow-x-auto p-3 transition-colors ${
          isOver ? 'bg-cyan/10' : 'bg-surface'
        }`}
      >
        {cards.length === 0 && (
          <span className="text-xs text-ink-muted/60">
            {isOver ? 'Solte aqui para agendar…' : 'Sem pacientes'}
          </span>
        )}
        {cards.map((c) => (
          <PatientCard key={c.id} paciente={c} />
        ))}
      </div>
    </div>
  );
}
