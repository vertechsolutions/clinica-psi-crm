'use client';
import { create } from 'zustand';
import type { Psicologa, Paciente, Preferencia, Modalidade } from '@/types';
import { buildPsicologas, buildPacientes } from '@/lib/mock-data';
import { slotIso, ocorrenciasSemanais } from '@/lib/datetime';

interface NovoCard {
  nome: string;
  preferencia: Preferencia;
  modalidade: Modalidade;
  resumo: string;
  frequenciaSemanal?: number;
  duracaoMeses?: number;
}

const uid = () => Math.random().toString(36).slice(2, 9);

interface KanbanState {
  psicologas: Psicologa[];
  pacientes: Paciente[];
  seeded: boolean;
  pending: { cardId: string; psicologaId: string; frequencia: number; meses: number } | null;
  seedDemo: () => void;
  openSchedule: (cardId: string, psicologaId: string) => void;
  closeSchedule: () => void;
  /** recebe 1 slot (avulso) ou N slots (pacote): gera os cards-sessão */
  confirmSchedule: (slotIsos: string[]) => void;
  unassign: (cardId: string) => void;
  addCard: (p: NovoCard) => void;
  marcarPago: (idOuGrupo: string) => void;
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

  openSchedule: (cardId, psicologaId) => {
    const card = get().pacientes.find((c) => c.id === cardId);
    const isPacote = card?.modalidade === 'pacote';
    const frequencia = isPacote ? card?.frequenciaSemanal ?? 1 : 1;
    const meses = isPacote ? card?.duracaoMeses ?? 1 : 0;
    set({ pending: { cardId, psicologaId, frequencia, meses } });
  },
  closeSchedule: () => set({ pending: null }),

  confirmSchedule: (slotIsos) =>
    set((s) => {
      const pend = s.pending;
      if (!pend || slotIsos.length === 0) return { pending: null };
      const base = s.pacientes.find((c) => c.id === pend.cardId);
      if (!base) return { pending: null };
      const grupoId = base.grupoId ?? `g${uid()}`;
      const meses = base.modalidade === 'pacote' ? base.duracaoMeses ?? 1 : 0;
      // cada horario base escolhido vira uma serie semanal no mesmo horario ao
      // longo dos meses do pacote; avulso (meses=0) fica so com o horario base.
      const isos = [
        ...new Set(slotIsos.flatMap((iso) => ocorrenciasSemanais(iso, meses))),
      ].sort((a, b) => a.localeCompare(b));
      const total = isos.length;
      // 1a sessao (cronologica) reaproveita o card arrastado; as demais sao novas
      const atualizados = s.pacientes.map((c) =>
        c.id === pend.cardId
          ? { ...c, psicologaId: pend.psicologaId, agendamentoIso: isos[0], grupoId, sessaoNum: 1, sessaoTotal: total }
          : c,
      );
      const extras: Paciente[] = isos.slice(1).map((iso, i) => ({
        ...base,
        id: `c${uid()}`,
        psicologaId: pend.psicologaId,
        agendamentoIso: iso,
        grupoId,
        sessaoNum: i + 2,
        sessaoTotal: total,
      }));
      // remove da agenda dessa semana so os slots realmente escolhidos
      const escolhidos = new Set(slotIsos);
      return {
        pending: null,
        psicologas: s.psicologas.map((ps) =>
          ps.id === pend.psicologaId
            ? { ...ps, agenda: ps.agenda.filter((sl) => !escolhidos.has(sl.iso)) }
            : ps,
        ),
        pacientes: [...atualizados, ...extras],
      };
    }),

  unassign: (cardId) =>
    set((s) => ({
      pacientes: s.pacientes.map((c) =>
        c.id === cardId ? { ...c, psicologaId: null, agendamentoIso: null } : c,
      ),
    })),

  addCard: (p) =>
    set((s) => {
      const isPacote = p.modalidade === 'pacote';
      return {
        pacientes: [
          ...s.pacientes,
          {
            nome: p.nome,
            preferencia: p.preferencia,
            modalidade: p.modalidade,
            resumo: p.resumo,
            id: `c${uid()}`,
            origem: 'WhatsApp',
            psicologaId: null,
            agendamentoIso: null,
            pago: false,
            frequenciaSemanal: isPacote ? p.frequenciaSemanal ?? 1 : undefined,
            duracaoMeses: isPacote ? p.duracaoMeses ?? 1 : undefined,
            grupoId: isPacote ? `g${uid()}` : undefined,
          },
        ],
      };
    }),

  marcarPago: (idOuGrupo) =>
    set((s) => ({
      pacientes: s.pacientes.map((c) =>
        c.id === idOuGrupo || (c.grupoId != null && c.grupoId === idOuGrupo)
          ? { ...c, pago: true }
          : c,
      ),
    })),
}));
