'use client';
import { useDroppable } from '@dnd-kit/core';
import type { Paciente } from '@/types';
import { PatientCard } from './patient-card';

export function UnassignedLane({ pacientes }: { pacientes: Paciente[] }) {
  const { setNodeRef, isOver } = useDroppable({ id: 'unassigned' });
  const cards = pacientes.filter((c) => c.psicologaId === null);

  return (
    <div className="sticky bottom-0 border-t-2 border-cyan-dark/30 bg-navy shadow-[0_-8px_24px_rgba(15,23,42,0.18)]">
      <div className="flex items-center gap-2 px-5 pt-3 text-xs font-semibold uppercase tracking-wide text-cyan">
        Não alocados
        <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-white/[0.12] px-1.5 text-cyan">
          {cards.length}
        </span>
        <span className="ml-1 font-normal normal-case text-white/45">arraste pra uma psicóloga →</span>
      </div>
      <div
        ref={setNodeRef}
        className={`flex min-h-[112px] items-center gap-3 overflow-x-auto p-5 transition-colors ${
          isOver ? 'bg-white/[0.06]' : ''
        }`}
      >
        {cards.length === 0 && <span className="text-xs text-white/40">Tudo distribuído 🎉</span>}
        {cards.map((c) => (
          <PatientCard key={c.id} paciente={c} />
        ))}
      </div>
    </div>
  );
}
