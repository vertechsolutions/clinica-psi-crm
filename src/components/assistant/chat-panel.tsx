'use client';
import { useRef, useState, useEffect } from 'react';
import { useAssistant, type Msg } from '@/stores/assistant-store';
import { useKanban } from '@/stores/kanban-store';

export function ChatPanel() {
  const messages = useAssistant((s) => s.messages);
  const systemPrompt = useAssistant((s) => s.systemPrompt);
  const loading = useAssistant((s) => s.loading);
  const push = useAssistant((s) => s.push);
  const setLoading = useAssistant((s) => s.setLoading);
  const reset = useAssistant((s) => s.reset);
  const addCard = useKanban((s) => s.addCard);
  const [text, setText] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  async function send() {
    const t = text.trim();
    if (!t || loading) return;
    const next: Msg[] = [...messages, { role: 'user', content: t }];
    push({ role: 'user', content: t });
    setText('');
    setLoading(true);
    try {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ system: systemPrompt, messages: next }),
      });
      const data = await r.json();
      push({ role: 'assistant', content: data.text || `⚠️ ${data.error ?? 'sem resposta'}` });
    } catch {
      push({ role: 'assistant', content: '⚠️ erro de rede' });
    } finally {
      setLoading(false);
    }
  }

  function mandarProCRM() {
    const ultimaUser = [...messages].reverse().find((m) => m.role === 'user');
    addCard({
      nome: 'Lead do chat',
      preferencia: 'indiferente',
      modalidade: 'avulso',
      resumo: ultimaUser?.content.slice(0, 120) ?? 'Veio da triagem do assistente.',
    });
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-surface">
      <div className="flex items-center justify-between border-b border-line px-4 py-2">
        <span className="text-sm font-semibold text-navy">Conversa de teste</span>
        <div className="flex gap-2">
          <button
            onClick={mandarProCRM}
            disabled={messages.length === 0}
            className="rounded-lg bg-cyan-dark px-2.5 py-1 text-xs font-medium text-white disabled:opacity-40"
          >
            Virou paciente → CRM
          </button>
          <button
            onClick={reset}
            className="rounded-lg px-2.5 py-1 text-xs text-ink-muted hover:text-navy"
          >
            Limpar
          </button>
        </div>
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto p-4">
        {messages.length === 0 && (
          <p className="mx-auto mt-8 max-w-xs text-center text-sm text-ink-muted">
            Converse aqui como se fosse um paciente chegando no WhatsApp. Ajuste o raciocínio ao
            lado e veja a assistente mudar.
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[78%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm ${
                m.role === 'user' ? 'bg-navy text-white' : 'bg-surface-2 text-ink'
              }`}
            >
              {m.content}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className="rounded-2xl bg-surface-2 px-3 py-2 text-sm text-ink-muted">digitando…</div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="flex gap-2 border-t border-line p-3">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder="Escreva como um paciente…"
          className="flex-1 rounded-xl border border-line bg-surface-2 px-3 py-2 text-sm outline-none focus:border-cyan-dark"
        />
        <button
          onClick={send}
          disabled={loading}
          className="rounded-xl bg-cyan-dark px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          Enviar
        </button>
      </div>
    </div>
  );
}
