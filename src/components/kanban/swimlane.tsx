'use client';
import { useDroppable } from '@dnd-kit/core';
import type { Psicologa, Paciente } from '@/types';
import { isPassado } from '@/lib/datetime';
import { PatientCard } from './patient-card';
import { Avatar } from '../avatar';

export function Swimlane({
  psicologa,
  pacientes,
  index = 0,
}: {
  psicologa: Psicologa;
  pacientes: Paciente[];
  index?: number;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: psicologa.id });
  const cards = pacientes
    .filter((c) => c.psicologaId === psicologa.id && !isPassado(c.agendamentoIso))
    .sort((a, b) => (a.agendamentoIso ?? '').localeCompare(b.agendamentoIso ?? ''));

  return (
    <div className="lane-in flex border-b border-line" style={{ animationDelay: `${index * 45}ms` }}>
      <div className="flex w-32 shrink-0 items-center gap-2 border-r border-line bg-gradient-to-b from-surface-2 to-surface p-2.5 sm:w-52 sm:gap-3 sm:p-4">
        <Avatar src={psicologa.foto} iniciais={psicologa.iniciais} cor={psicologa.cor} size={36} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-semibold leading-tight text-navy sm:text-sm">{psicologa.nome}</div>
          <div className="truncate text-[10px] text-ink-muted sm:text-[11px]">{psicologa.especialidade}</div>
        </div>
        <span className="hidden h-6 min-w-6 items-center justify-center rounded-full bg-navy/5 px-1.5 text-[11px] font-medium text-ink-muted sm:flex">
          {cards.length}
        </span>
      </div>
      <div
        ref={setNodeRef}
        className={`flex min-h-[112px] flex-1 items-center gap-3 overflow-x-auto p-3 transition-all sm:p-4 ${
          isOver ? 'bg-cyan/5 ring-2 ring-inset ring-cyan-dark/40' : 'bg-surface'
        }`}
      >
        {cards.length === 0 && (
          <span className="text-xs text-ink-muted/60">
            {isOver ? '✓ solte aqui pra agendar' : 'sem pacientes'}
          </span>
        )}
        {cards.map((c) => (
          <PatientCard key={c.id} paciente={c} />
        ))}
      </div>
    </div>
  );
}
