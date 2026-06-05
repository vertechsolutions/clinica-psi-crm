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
      <div className="border-b border-line px-4 py-2">
        <div className="text-sm font-semibold text-navy">Raciocínio da assistente</div>
        <div className="text-xs text-ink-muted">
          Ajuste como ela deve pensar e responder. Quando estiver no ponto, é esse raciocínio que
          vai pro WhatsApp.
        </div>
      </div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        className="min-h-[200px] flex-1 resize-none bg-surface-2 p-4 font-mono text-xs leading-relaxed text-ink outline-none"
      />
      <div className="flex items-center gap-2 border-t border-line p-3">
        <button
          onClick={salvar}
          className="rounded-lg bg-navy px-3 py-1.5 text-sm font-medium text-white"
        >
          Salvar raciocínio
        </button>
        <button
          onClick={() => setDraft(DEFAULT_PROMPT)}
          className="rounded-lg px-3 py-1.5 text-sm text-ink-muted hover:text-navy"
        >
          Restaurar padrão
        </button>
        {saved && <span className="text-xs font-medium text-cyan-dark">salvo ✓</span>}
      </div>
    </div>
  );
}
