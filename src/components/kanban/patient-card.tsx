'use client';
import { useDraggable } from '@dnd-kit/core';
import type { Paciente, Preferencia } from '@/types';
import { fmtData } from '@/lib/datetime';
import { useKanban } from '@/stores/kanban-store';

const prefChip: Record<Preferencia, { label: string; cls: string }> = {
  F: { label: '♀ prefere mulher', cls: 'bg-pink/10 text-pink' },
  M: { label: '♂ prefere homem', cls: 'bg-blue/10 text-blue' },
  indiferente: { label: 'tanto faz', cls: 'bg-ink-muted/10 text-ink-muted' },
};

export function PatientCard({ paciente, overlay = false }: { paciente: Paciente; overlay?: boolean }) {
  const unassign = useKanban((s) => s.unassign);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: overlay ? `ov-${paciente.id}` : paciente.id,
    disabled: overlay,
  });
  const pref = prefChip[paciente.preferencia];
  const alocado = paciente.psicologaId !== null;

  const base = 'relative w-60 shrink-0 rounded-2xl border border-line bg-surface p-4 transition-all';
  const cls = overlay
    ? `${base} rotate-[3deg] scale-[1.04] shadow-2xl ring-2 ring-cyan-dark/30`
    : isDragging
      ? `${base} opacity-30`
      : `${base} shadow-sm hover:-translate-y-0.5 hover:shadow-md`;

  return (
    <div ref={overlay ? undefined : setNodeRef} className={cls}>
      <div
        {...(overlay ? {} : listeners)}
        {...(overlay ? {} : attributes)}
        className={overlay ? 'cursor-grabbing' : 'cursor-grab touch-none active:cursor-grabbing'}
      >
        <div className="flex items-start justify-between gap-2">
          <span className="text-[15px] font-semibold leading-tight text-navy">{paciente.nome}</span>
          <span className="mt-0.5 shrink-0 rounded-md bg-[#25D366]/[0.12] px-1.5 py-0.5 text-[10px] font-semibold text-[#0e8a43]">
            {paciente.origem}
          </span>
        </div>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <span className={`rounded-md px-2 py-0.5 text-[11px] font-medium ${pref.cls}`}>{pref.label}</span>
          <span className="rounded-md bg-navy/5 px-2 py-0.5 text-[11px] font-medium capitalize text-ink-muted">
            {paciente.modalidade}
          </span>
        </div>
        <p className="mt-2.5 line-clamp-2 text-[13px] leading-relaxed text-ink-muted">{paciente.resumo}</p>
        {paciente.agendamentoIso && (
          <div className="mt-3 flex items-center gap-1.5 rounded-lg bg-cyan-dark/10 px-2.5 py-1.5 text-[12px] font-semibold text-cyan-dark">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="18" rx="2" />
              <path d="M16 2v4M8 2v4M3 10h18" />
            </svg>
            {fmtData(paciente.agendamentoIso)}
          </div>
        )}
      </div>
      {alocado && !overlay && (
        <button
          onClick={() => unassign(paciente.id)}
          className="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full border border-line bg-surface text-ink-muted shadow-md transition-colors hover:border-pink hover:text-pink"
          title="Devolver pra não alocados"
        >
          ×
        </button>
      )}
    </div>
  );
}
