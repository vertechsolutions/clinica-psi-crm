'use client';
import { create } from 'zustand';
import { DEFAULT_PROMPT } from '@/lib/default-prompt';
import type { LeadExtraido } from '@/lib/triagem';

export interface Msg {
  role: 'user' | 'assistant';
  content: string;
}

interface AssistantState {
  messages: Msg[];
  systemPrompt: string;
  loading: boolean;
  /** ultimo lead extraido pela triagem (acumulado ao longo da conversa) */
  ultimoLead: LeadExtraido | null;
  /** trava de idempotencia: card ja foi criado pra esta conversa */
  leadCriado: boolean;
  setSystemPrompt: (p: string) => void;
  loadPrompt: () => void;
  push: (m: Msg) => void;
  setLoading: (b: boolean) => void;
  setUltimoLead: (l: LeadExtraido) => void;
  setLeadCriado: (b: boolean) => void;
  reset: () => void;
}

const KEY = 'clinica-psi-prompt';

export const useAssistant = create<AssistantState>((set) => ({
  messages: [],
  systemPrompt: DEFAULT_PROMPT,
  loading: false,
  ultimoLead: null,
  leadCriado: false,
  setSystemPrompt: (p) => {
    try {
      localStorage.setItem(KEY, p);
    } catch {}
    set({ systemPrompt: p });
  },
  loadPrompt: () => {
    try {
      const s = localStorage.getItem(KEY);
      if (s) set({ systemPrompt: s });
    } catch {}
  },
  push: (m) => set((s) => ({ messages: [...s.messages, m] })),
  setLoading: (b) => set({ loading: b }),
  setUltimoLead: (l) => set({ ultimoLead: l }),
  setLeadCriado: (b) => set({ leadCriado: b }),
  reset: () => set({ messages: [], ultimoLead: null, leadCriado: false }),
}));
