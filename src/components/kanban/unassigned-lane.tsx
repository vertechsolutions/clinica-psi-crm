'use client';
import { useDroppable } from '@dnd-kit/core';
import type { Paciente } from '@/types';
import { PatientCard } from './patient-card';

export function UnassignedLane({ pacientes }: { pacientes: Paciente[] }) {
  const { setNodeRef, isOver } = useDroppable({ id: 'unassigned' });
  const cards = pacientes.filter((c) => c.psicologaId === null);

  return (
    <div className="sticky bottom-0 border-t-2 border-cyan-dark/30 bg-navy">
      <div className="flex items-center gap-2 px-4 pt-2 text-xs font-semibold uppercase tracking-wide text-cyan">
        Não alocados
        <span className="rounded-full bg-white/10 px-1.5 text-cyan">{cards.length}</span>
        <span className="ml-1 font-normal normal-case text-white/50">arraste pra uma psicóloga →</span>
      </div>
      <div
        ref={setNodeRef}
        className={`flex min-h-[96px] items-center gap-3 overflow-x-auto p-4 transition-colors ${
          isOver ? 'bg-white/5' : ''
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
