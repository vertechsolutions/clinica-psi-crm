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
  // no mobile o painel comeca recolhido pra dar a tela toda pro chat
  const [aberto, setAberto] = useState(false);

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
    <div className="flex w-full shrink-0 flex-col border-b border-line bg-surface md:w-[42%] md:shrink md:border-b-0 md:border-r">
      <div className="border-b border-line px-4 py-2.5 sm:px-5 sm:py-3">
        <button
          type="button"
          onClick={() => setAberto((v) => !v)}
          className="flex w-full items-center gap-2 md:cursor-default"
        >
          <span className="flex h-6 items-center rounded-md bg-navy/5 px-2 text-[10px] font-bold uppercase tracking-wide text-cyan-dark">
            system prompt
          </span>
          <div className="text-sm font-semibold text-navy">Raciocínio da assistente</div>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`ml-auto text-ink-muted transition-transform md:hidden ${aberto ? 'rotate-180' : ''}`}
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
        <div className="mt-1 hidden text-xs leading-relaxed text-ink-muted md:block">
          Ajuste como ela deve pensar e responder. Quando estiver no ponto, é esse raciocínio que
          vai pro WhatsApp.
        </div>
      </div>
      <div className={`${aberto ? 'flex' : 'hidden'} flex-1 flex-col md:flex`}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          className="h-48 resize-none bg-surface-2 p-4 font-mono text-xs leading-relaxed text-ink outline-none sm:p-5 md:h-auto md:min-h-[220px] md:flex-1"
        />
        <div className="flex items-center gap-2 border-t border-line p-3 sm:p-4">
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
    </div>
  );
}
