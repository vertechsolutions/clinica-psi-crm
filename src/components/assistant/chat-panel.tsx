'use client';
import { useRef, useState, useEffect } from 'react';
import { useAssistant, type Msg } from '@/stores/assistant-store';
import type { LeadExtraido } from '@/lib/triagem';
import { Avatar } from '../avatar';
import { FichaTriagem } from './ficha-triagem';

const ASSIST_AVATAR = 'https://randomuser.me/api/portraits/women/79.jpg';

export function ChatPanel() {
  const messages = useAssistant((s) => s.messages);
  const systemPrompt = useAssistant((s) => s.systemPrompt);
  const loading = useAssistant((s) => s.loading);
  const ultimoLead = useAssistant((s) => s.ultimoLead);
  const push = useAssistant((s) => s.push);
  const setLoading = useAssistant((s) => s.setLoading);
  const setUltimoLead = useAssistant((s) => s.setUltimoLead);
  const reset = useAssistant((s) => s.reset);
  const [text, setText] = useState('');
  const [pronto, setPronto] = useState(false);
  const [verFicha, setVerFicha] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading, verFicha]);

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
      if (data.error) {
        push({ role: 'assistant', content: `⚠️ ${data.error}` });
        return;
      }
      push({ role: 'assistant', content: data.resposta || '⚠️ sem resposta' });
      if (data.lead) setUltimoLead(data.lead as LeadExtraido);
      if (data.pronto) {
        setPronto(true);
        setVerFicha(true);
      }
    } catch {
      push({ role: 'assistant', content: '⚠️ erro de rede' });
    } finally {
      setLoading(false);
    }
  }

  function limpar() {
    reset();
    setPronto(false);
    setVerFicha(false);
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-surface">
      <div className="flex items-center justify-between border-b border-line px-5 py-3">
        <div className="flex items-center gap-2.5">
          <div className="relative">
            <Avatar src={ASSIST_AVATAR} iniciais="IA" cor="#0891b2" size={38} />
            <span className="pulse-dot absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white bg-[#25D366]" />
          </div>
          <div>
            <div className="text-sm font-semibold text-navy">Assistente</div>
            <div className="text-[11px] font-medium text-[#0e8a43]">online · triagem WhatsApp</div>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setVerFicha((v) => !v)}
            disabled={!ultimoLead}
            title="Ver o que a assistente captou da conversa"
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-40 ${
              verFicha ? 'bg-cyan-dark text-white' : 'bg-surface-2 text-navy hover:bg-navy/5'
            }`}
          >
            {verFicha ? 'Ocultar ficha' : 'Ver ficha'}
          </button>
          <button
            onClick={limpar}
            className="rounded-lg px-2.5 py-1.5 text-xs text-ink-muted transition-colors hover:bg-surface-2 hover:text-navy"
          >
            Limpar
          </button>
        </div>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-5">
        {messages.length === 0 && (
          <p className="mx-auto mt-10 max-w-xs text-center text-sm leading-relaxed text-ink-muted">
            Converse como se fosse alguém chegando no WhatsApp da clínica. A assistente acolhe, tira
            dúvidas e conduz até o agendamento. Use “Ver ficha” pra conferir o que ela captou.
          </p>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={`fade-in flex items-end gap-2 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            {m.role === 'assistant' && (
              <Avatar src={ASSIST_AVATAR} iniciais="IA" cor="#0891b2" size={26} ring={false} />
            )}
            <div
              className={`max-w-[76%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm shadow-sm ${
                m.role === 'user'
                  ? 'rounded-br-md bg-navy text-white'
                  : 'rounded-bl-md bg-surface-2 text-ink'
              }`}
            >
              {m.content}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex items-end gap-2">
            <Avatar src={ASSIST_AVATAR} iniciais="IA" cor="#0891b2" size={26} ring={false} />
            <div className="flex gap-1 rounded-2xl rounded-bl-md bg-surface-2 px-4 py-3.5">
              <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-ink-muted" />
              <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-ink-muted" style={{ animationDelay: '0.2s' }} />
              <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-ink-muted" style={{ animationDelay: '0.4s' }} />
            </div>
          </div>
        )}
        {verFicha && <FichaTriagem lead={ultimoLead} pronto={pronto} />}
        <div ref={endRef} />
      </div>

      <div className="flex items-center gap-2 border-t border-line p-4">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder="Escreva como um paciente…"
          className="flex-1 rounded-2xl border border-line bg-surface-2 px-4 py-2.5 text-sm outline-none transition-colors focus:border-cyan-dark focus:bg-surface"
        />
        <button
          onClick={send}
          disabled={loading}
          title="Enviar"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-cyan-dark text-white transition-all hover:scale-105 hover:bg-cyan-dark/90 disabled:opacity-40 disabled:hover:scale-100"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
          </svg>
        </button>
      </div>
    </div>
  );
}
