'use client';
import { useEffect, useState } from 'react';
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { useKanban } from '@/stores/kanban-store';
import { Swimlane } from './swimlane';
import { UnassignedLane } from './unassigned-lane';
import { SchedulePopup } from './schedule-popup';
import { ArchivedView } from './archived-view';

export function Board() {
  const seedDemo = useKanban((s) => s.seedDemo);
  const psicologas = useKanban((s) => s.psicologas);
  const pacientes = useKanban((s) => s.pacientes);
  const openSchedule = useKanban((s) => s.openSchedule);
  const unassign = useKanban((s) => s.unassign);
  const [sub, setSub] = useState<'distribuicao' | 'arquivados'>('distribuicao');

  useEffect(() => {
    seedDemo();
  }, [seedDemo]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  function onDragEnd(e: DragEndEvent) {
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
      <div className="flex gap-1 border-b border-line bg-surface px-4 pt-3">
        {(['distribuicao', 'arquivados'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setSub(t)}
            className={`rounded-t-lg px-3 py-1.5 text-sm font-medium transition-colors ${
              sub === t ? 'bg-bg text-navy' : 'text-ink-muted hover:text-navy'
            }`}
          >
            {t === 'distribuicao' ? 'Distribuição' : 'Arquivados'}
          </button>
        ))}
      </div>

      {sub === 'arquivados' ? (
        <ArchivedView />
      ) : (
        <DndContext sensors={sensors} onDragEnd={onDragEnd}>
          <div className="flex flex-1 flex-col overflow-hidden">
            <div className="flex-1 overflow-y-auto">
              {psicologas.map((p) => (
                <Swimlane key={p.id} psicologa={p} pacientes={pacientes} />
              ))}
            </div>
            <UnassignedLane pacientes={pacientes} />
          </div>
          <SchedulePopup />
        </DndContext>
      )}
    </div>
  );
}
