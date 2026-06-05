'use client';
import { useEffect, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { useKanban } from '@/stores/kanban-store';
import { Swimlane } from './swimlane';
import { UnassignedLane } from './unassigned-lane';
import { SchedulePopup } from './schedule-popup';
import { ArchivedView } from './archived-view';
import { PatientCard } from './patient-card';

export function Board() {
  const seedDemo = useKanban((s) => s.seedDemo);
  const psicologas = useKanban((s) => s.psicologas);
  const pacientes = useKanban((s) => s.pacientes);
  const openSchedule = useKanban((s) => s.openSchedule);
  const unassign = useKanban((s) => s.unassign);
  const [sub, setSub] = useState<'distribuicao' | 'arquivados'>('distribuicao');
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeCard = pacientes.find((c) => c.id === activeId) ?? null;

  useEffect(() => {
    seedDemo();
  }, [seedDemo]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  function onDragEnd(e: DragEndEvent) {
    setActiveId(null);
    const cardId = String(e.active.id);
    const dest = e.over ? String(e.over.id) : null;
    if (!dest) return;
    if (dest === 'unassigned') {
      unassign(cardId);
      return;
    }
    openSchedule(cardId, dest);
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex gap-1 border-b border-line bg-surface px-4 pt-2">
        {(['distribuicao', 'arquivados'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setSub(t)}
            className={`px-3.5 py-2.5 text-sm font-medium transition-colors ${
              sub === t
                ? 'border-b-2 border-cyan-dark text-navy'
                : 'border-b-2 border-transparent text-ink-muted hover:text-navy'
            }`}
          >
            {t === 'distribuicao' ? 'Distribuição' : 'Arquivados'}
          </button>
        ))}
      </div>

      {sub === 'arquivados' ? (
        <ArchivedView />
      ) : (
        <DndContext
          sensors={sensors}
          onDragStart={(e: DragStartEvent) => setActiveId(String(e.active.id))}
          onDragEnd={onDragEnd}
          onDragCancel={() => setActiveId(null)}
        >
          <div className="flex flex-1 flex-col overflow-hidden">
            <div className="flex-1 overflow-y-auto">
              {psicologas.map((p, i) => (
                <Swimlane key={p.id} psicologa={p} pacientes={pacientes} index={i} />
              ))}
            </div>
            <UnassignedLane pacientes={pacientes} />
          </div>
          <DragOverlay dropAnimation={{ duration: 220, easing: 'cubic-bezier(0.18,0.67,0.6,1.22)' }}>
            {activeCard ? <PatientCard paciente={activeCard} overlay /> : null}
          </DragOverlay>
          <SchedulePopup />
        </DndContext>
      )}
    </div>
  );
}
