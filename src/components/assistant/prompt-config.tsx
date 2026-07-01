'use client';
import { useEffect, useState } from 'react';
import { useAssistant } from '@/stores/assistant-store';
import { DEFAULT_PROMPT } from '@/lib/default-prompt';

type SaveState = 'idle' | 'saving' | 'saved' | 'local' | 'unauthorized';
const ADMIN_KEY_LS = 'clinica-admin-key';

export function PromptConfig() {
  const systemPrompt = useAssistant((s) => s.systemPrompt);
  const setSystemPrompt = useAssistant((s) => s.setSystemPrompt);
  const loadPrompt = useAssistant((s) => s.loadPrompt);
  const [draft, setDraft] = useState(systemPrompt);
  const [save, setSave] = useState<SaveState>('idle');
  const [adminKey, setAdminKey] = useState('');
  // no mobile o painel comeca recolhido pra dar a tela toda pro chat
  const [aberto, setAberto] = useState(false);

  // Ordem: carrega o localStorage (offline) e, com a chave de admin, busca o
  // raciocinio ATIVO no servidor (o que o WhatsApp usa). Se o servidor tiver, manda.
  useEffect(() => {
    loadPrompt();
    const key = localStorage.getItem(ADMIN_KEY_LS) ?? '';
    setAdminKey(key);
    fetch('/api/config', { headers: key ? { 'x-admin-key': key } : {} })
      .then((r) => r.json())
      .then((d: { prompt?: string; persisted?: boolean }) => {
        if (d?.persisted && typeof d.prompt === 'string' && d.prompt.trim()) {
          setSystemPrompt(d.prompt);
          setDraft(d.prompt);
        }
      })
      .catch(() => {});
  }, [loadPrompt, setSystemPrompt]);

  useEffect(() => {
    setDraft(systemPrompt);
  }, [systemPrompt]);

  async function salvar() {
    setSystemPrompt(draft); // cache local (tela de teste)
    localStorage.setItem(ADMIN_KEY_LS, adminKey);
    setSave('saving');
    try {
      const r = await fetch('/api/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(adminKey ? { 'x-admin-key': adminKey } : {}) },
        body: JSON.stringify({ prompt: draft }),
      });
      if (r.status === 401) setSave('unauthorized');
      else setSave(r.ok ? 'saved' : 'local');
    } catch {
      setSave('local');
    }
    setTimeout(() => setSave('idle'), 2600);
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
          Ajuste como ela deve pensar e responder. Ao salvar, esse raciocínio passa a valer também no
          WhatsApp da clínica.
        </div>
      </div>
      <div className={`${aberto ? 'flex' : 'hidden'} flex-1 flex-col md:flex`}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          className="h-48 resize-none bg-surface-2 p-4 font-mono text-xs leading-relaxed text-ink outline-none sm:p-5 md:h-auto md:min-h-[220px] md:flex-1"
        />
        <div className="flex flex-col gap-2 border-t border-line p-3 sm:p-4">
          <div className="flex items-center gap-2">
            <button
              onClick={salvar}
              disabled={save === 'saving'}
              className="rounded-lg bg-navy px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-navy-2 disabled:opacity-50"
            >
              {save === 'saving' ? 'Salvando…' : 'Salvar raciocínio'}
            </button>
            <button
              onClick={() => setDraft(DEFAULT_PROMPT)}
              className="rounded-lg px-3 py-2 text-sm text-ink-muted transition-colors hover:bg-surface-2 hover:text-navy"
            >
              Restaurar padrão
            </button>
            <input
              type="password"
              value={adminKey}
              onChange={(e) => setAdminKey(e.target.value)}
              placeholder="chave de admin"
              className="ml-auto w-32 rounded-lg border border-line bg-surface-2 px-2.5 py-1.5 text-xs outline-none focus:border-cyan-dark"
            />
          </div>
          {save === 'saved' && <span className="fade-in text-xs font-medium text-cyan-dark">salvo · vale no WhatsApp ✓</span>}
          {save === 'local' && <span className="fade-in text-xs font-medium text-amber-600">salvo só localmente (sem banco)</span>}
          {save === 'unauthorized' && <span className="fade-in text-xs font-medium text-red-600">chave de admin inválida — salvo só localmente</span>}
        </div>
      </div>
    </div>
  );
}
