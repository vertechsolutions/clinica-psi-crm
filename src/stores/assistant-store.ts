'use client';
import { create } from 'zustand';
import { DEFAULT_PROMPT, PROMPT_VERSION } from '@/lib/default-prompt';
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
  setSystemPrompt: (p: string) => void;
  loadPrompt: () => void;
  push: (m: Msg) => void;
  setLoading: (b: boolean) => void;
  setUltimoLead: (l: LeadExtraido) => void;
  reset: () => void;
}

const KEY = 'clinica-psi-prompt';

/** Formato persistido no localStorage: o texto do prompt + a versao que o gerou. */
interface StoredPrompt {
  version: string;
  text: string;
}

/** Grava o prompt no localStorage sempre carimbado com a PROMPT_VERSION atual. */
function persist(text: string) {
  try {
    const payload: StoredPrompt = { version: PROMPT_VERSION, text };
    localStorage.setItem(KEY, JSON.stringify(payload));
  } catch {}
}

export const useAssistant = create<AssistantState>((set) => ({
  messages: [],
  systemPrompt: DEFAULT_PROMPT,
  loading: false,
  ultimoLead: null,
  setSystemPrompt: (p) => {
    persist(p);
    set({ systemPrompt: p });
  },
  loadPrompt: () => {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) {
        // nada salvo: garante o padrao atual ja carimbado com a versao
        persist(DEFAULT_PROMPT);
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // formato legado (string pura, sem versao): descarta e usa o padrao novo
        persist(DEFAULT_PROMPT);
        set({ systemPrompt: DEFAULT_PROMPT });
        return;
      }
      const saved = parsed as Partial<StoredPrompt>;
      if (
        saved &&
        typeof saved.version === 'string' &&
        typeof saved.text === 'string' &&
        saved.version === PROMPT_VERSION
      ) {
        // mesma versao: respeita as edicoes manuais do usuario
        set({ systemPrompt: saved.text });
      } else {
        // versao diferente/ausente: forca o prompt novo e re-persiste com a versao atual
        persist(DEFAULT_PROMPT);
        set({ systemPrompt: DEFAULT_PROMPT });
      }
    } catch {}
  },
  push: (m) => set((s) => ({ messages: [...s.messages, m] })),
  setLoading: (b) => set({ loading: b }),
  setUltimoLead: (l) => set({ ultimoLead: l }),
  reset: () => set({ messages: [], ultimoLead: null }),
}));
