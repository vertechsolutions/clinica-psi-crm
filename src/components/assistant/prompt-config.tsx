'use client';
import { useEffect, useState } from 'react';
import { useAssistant } from '@/stores/assistant-store';
import { DEFAULT_PROMPT } from '@/lib/default-prompt';

export function PromptConfig() {
  const systemPrompt = useAssistant((s) => s.systemPrompt);
  const setSystemPrompt = useAssistant((s) => s.setSystemPrompt);
  const loadPrompt = useAssistant((s) => s.loadPrompt);
  const [draft, setDraft] = useState(systemPrompt);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    loadPrompt();
  }, [loadPrompt]);
  useEffect(() => {
    setDraft(systemPrompt);
  }, [systemPrompt]);

  function salvar() {
    setSystemPrompt(draft);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  return (
    <div className="flex w-full flex-col border-b border-line bg-surface md:w-[42%] md:border-b-0 md:border-r">
      <div className="border-b border-line px-5 py-3">
        <div className="flex items-center gap-2">
          <span className="flex h-6 items-center rounded-md bg-navy/5 px-2 text-[10px] font-bold uppercase tracking-wide text-cyan-dark">
            system prompt
          </span>
          <div className="text-sm font-semibold text-navy">Raciocínio da assistente</div>
        </div>
        <div className="mt-1 text-xs leading-relaxed text-ink-muted">
          Ajuste como ela deve pensar e responder. Quando estiver no ponto, é esse raciocínio que
          vai pro WhatsApp.
        </div>
      </div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        className="min-h-[220px] flex-1 resize-none bg-surface-2 p-5 font-mono text-xs leading-relaxed text-ink outline-none"
      />
      <div className="flex items-center gap-2 border-t border-line p-4">
        <button
          onClick={salvar}
          className="rounded-lg bg-navy px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-navy-2"
        >
          Salvar raciocínio
        </button>
        <button
          onClick={() => setDraft(DEFAULT_PROMPT)}
          className="rounded-lg px-3 py-2 text-sm text-ink-muted transition-colors hover:bg-surface-2 hover:text-navy"
        >
          Restaurar padrão
        </button>
        {saved && <span className="fade-in text-xs font-medium text-cyan-dark">salvo ✓</span>}
      </div>
    </div>
  );
}
