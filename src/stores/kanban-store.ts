'use client';
import { create } from 'zustand';
import type { Psicologa, Paciente, Preferencia, Modalidade } from '@/types';
import { buildPsicologas, buildPacientes } from '@/lib/mock-data';
import { slotIso } from '@/lib/datetime';

interface NovoCard {
  nome: string;
  preferencia: Preferencia;
  modalidade: Modalidade;
  resumo: string;
}

interface KanbanState {
  psicologas: Psicologa[];
  pacientes: Paciente[];
  seeded: boolean;
  pending: { cardId: string; psicologaId: string } | null;
  seedDemo: () => void;
  openSchedule: (cardId: string, psicologaId: string) => void;
  closeSchedule: () => void;
  confirmSchedule: (slotIsoStr: string) => void;
  unassign: (cardId: string) => void;
  addCard: (p: NovoCard) => void;
}

export const useKanban = create<KanbanState>((set, get) => ({
  psicologas: [],
  pacientes: [],
  seeded: false,
  pending: null,

  seedDemo: () => {
    if (get().seeded) return;
    const pac = buildPacientes();
    const c6 = pac.find((p) => p.id === 'c6');
    const c7 = pac.find((p) => p.id === 'c7');
    if (c6) c6.agendamentoIso = slotIso(1, 14); // futuro → swimlane p1
    if (c7) c7.agendamentoIso = slotIso(-2, 10); // passado → arquivo
    set({ psicologas: buildPsicologas(), pacientes: pac, seeded: true });
  },

  openSchedule: (cardId, psicologaId) => set({ pending: { cardId, psicologaId } }),
  closeSchedule: () => set({ pending: null }),

  confirmSchedule: (slotIsoStr) =>
    set((s) => {
      const pend = s.pending;
      if (!pend) return {};
      return {
        pending: null,
        psicologas: s.psicologas.map((ps) =>
          ps.id === pend.psicologaId
            ? { ...ps, agenda: ps.agenda.filter((sl) => sl.iso !== slotIsoStr) }
            : ps,
        ),
        pacientes: s.pacientes.map((c) =>
          c.id === pend.cardId
            ? { ...c, psicologaId: pend.psicologaId, agendamentoIso: slotIsoStr }
            : c,
        ),
      };
    }),

  unassign: (cardId) =>
    set((s) => ({
      pacientes: s.pacientes.map((c) =>
        c.id === cardId ? { ...c, psicologaId: null, agendamentoIso: null } : c,
      ),
    })),

  addCard: (p) =>
    set((s) => ({
      pacientes: [
        ...s.pacientes,
        {
          ...p,
          id: `c${Date.now()}`,
          origem: 'WhatsApp',
          psicologaId: null,
          agendamentoIso: null,
        },
      ],
    })),
}));
