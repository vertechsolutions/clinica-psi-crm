'use client';
import { create } from 'zustand';
import { DEFAULT_PROMPT } from '@/lib/default-prompt';

export interface Msg {
  role: 'user' | 'assistant';
  content: string;
}

interface AssistantState {
  messages: Msg[];
  systemPrompt: string;
  loading: boolean;
  setSystemPrompt: (p: string) => void;
  loadPrompt: () => void;
  push: (m: Msg) => void;
  setLoading: (b: boolean) => void;
  reset: () => void;
}

const KEY = 'clinica-psi-prompt';

export const useAssistant = create<AssistantState>((set) => ({
  messages: [],
  systemPrompt: DEFAULT_PROMPT,
  loading: false,
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
  reset: () => set({ messages: [] }),
}));
