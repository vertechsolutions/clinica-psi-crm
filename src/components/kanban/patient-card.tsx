'use client';
import { useDraggable } from '@dnd-kit/core';
import type { Paciente, Preferencia } from '@/types';
import { fmtData } from '@/lib/datetime';
import { useKanban } from '@/stores/kanban-store';

const prefChip: Record<Preferencia, { label: string; cls: string }> = {
  F: { label: 'prefere mulher', cls: 'bg-pink/10 text-pink' },
  M: { label: 'prefere homem', cls: 'bg-blue/10 text-blue' },
  indiferente: { label: 'indiferente', cls: 'bg-ink-muted/10 text-ink-muted' },
};

export function PatientCard({ paciente }: { paciente: Paciente }) {
  const unassign = useKanban((s) => s.unassign);
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: paciente.id,
  });
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, zIndex: 50 }
    : undefined;
  const pref = prefChip[paciente.preferencia];
  const alocado = paciente.psicologaId !== null;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`relative w-56 shrink-0 rounded-xl border border-line bg-surface p-3 shadow-sm transition-shadow ${
        isDragging ? 'opacity-60 shadow-lg' : 'hover:shadow-md'
      }`}
    >
      <div {...listeners} {...attributes} className="cursor-grab touch-none active:cursor-grabbing">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-navy">{paciente.nome}</span>
          <span className="rounded bg-cyan-dark/10 px-1.5 py-0.5 text-[10px] font-medium text-cyan-dark">
            {paciente.origem}
          </span>
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1">
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${pref.cls}`}>
            {pref.label}
          </span>
          <span className="rounded bg-navy/5 px-1.5 py-0.5 text-[10px] font-medium text-ink-muted">
            {paciente.modalidade}
          </span>
        </div>
        <p className="mt-1.5 line-clamp-2 text-xs text-ink-muted">{paciente.resumo}</p>
        {paciente.agendamentoIso && (
          <div className="mt-2 rounded-md bg-cyan-dark/10 px-2 py-1 text-[11px] font-semibold text-cyan-dark">
            🗓 {fmtData(paciente.agendamentoIso)}
          </div>
        )}
      </div>
      {alocado && (
        <button
          onClick={() => unassign(paciente.id)}
          className="absolute -right-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full border border-line bg-surface text-ink-muted shadow hover:text-pink"
          title="Devolver pra não alocados"
        >
          ×
        </button>
      )}
    </div>
  );
}
