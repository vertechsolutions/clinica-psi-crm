'use client';
import { useRef, useState, useEffect } from 'react';
import { useAssistant, type Msg } from '@/stores/assistant-store';
import { useKanban } from '@/stores/kanban-store';
import type { LeadExtraido } from '@/lib/triagem';
import { Avatar } from '../avatar';

const ASSIST_AVATAR = 'https://randomuser.me/api/portraits/women/79.jpg';

/** Converte o lead extraido pela triagem num card do kanban, com defaults seguros. */
function leadParaCard(lead: LeadExtraido | null, fallbackResumo: string) {
  const modalidade = lead?.modalidade ?? 'avulso';
  const resumo =
    lead?.resumo?.trim() || lead?.motivacao?.trim() || fallbackResumo;
  return {
    nome: lead?.nome?.trim() || 'Lead do chat',
    preferencia: lead?.preferencia ?? 'indiferente',
    modalidade,
    frequenciaSemanal: modalidade === 'pacote' ? lead?.frequenciaSemanal ?? 1 : undefined,
    duracaoMeses: modalidade === 'pacote' ? lead?.duracaoMeses ?? 1 : undefined,
    resumo,
    // ficha completa anexada ao card (vira o "Ver detalhes" no painel)
    triagem: {
      motivacao: lead?.motivacao ?? null,
      expectativa: lead?.expectativa ?? null,
      sintomas: lead?.sintomas ?? [],
      diagnostico: lead?.diagnostico ?? null,
      terapiaAnterior: lead?.terapiaAnterior ?? null,
      preferenciaAbordagem: lead?.preferenciaAbordagem ?? null,
      disponibilidade: lead?.disponibilidade ?? null,
      dataNascimento: lead?.dataNascimento ?? null,
      email: lead?.email ?? null,
      telefone: lead?.telefone ?? null,
      contatoEmergencia: lead?.contatoEmergencia ?? null,
      profissao: lead?.profissao ?? null,
      statusRelacionamento: lead?.statusRelacionamento ?? null,
      filhos: lead?.filhos ?? null,
      vicios: lead?.vicios ?? null,
      notaFiscal: lead?.notaFiscal ?? null,
      observacoes: lead?.observacoes ?? null,
    },
  };
}

export function ChatPanel({ onGoToBoard }: { onGoToBoard?: () => void }) {
  const messages = useAssistant((s) => s.messages);
  const systemPrompt = useAssistant((s) => s.systemPrompt);
  const loading = useAssistant((s) => s.loading);
  const ultimoLead = useAssistant((s) => s.ultimoLead);
  const leadCriado = useAssistant((s) => s.leadCriado);
  const push = useAssistant((s) => s.push);
  const setLoading = useAssistant((s) => s.setLoading);
  const setUltimoLead = useAssistant((s) => s.setUltimoLead);
  const setLeadCriado = useAssistant((s) => s.setLeadCriado);
  const reset = useAssistant((s) => s.reset);
  const addCard = useKanban((s) => s.addCard);
  const [text, setText] = useState('');
  const [cardCriadoNome, setCardCriadoNome] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading, cardCriadoNome]);

  function criarCard(lead: LeadExtraido | null, fallback: string) {
    const card = leadParaCard(lead, fallback);
    addCard(card);
    setLeadCriado(true);
    setCardCriadoNome(card.nome);
  }

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
      // cria o card automaticamente quando a triagem terminou de coletar as infos
      if (data.pronto && !useAssistant.getState().leadCriado) {
        criarCard(data.lead as LeadExtraido, t.slice(0, 120));
      }
    } catch {
      push({ role: 'assistant', content: '⚠️ erro de rede' });
    } finally {
      setLoading(false);
    }
  }

  // override manual: usa os dados ja extraidos da conversa (nao mais hardcoded)
  function mandarProCRM() {
    if (leadCriado) return;
    const ultimaUser = [...messages].reverse().find((m) => m.role === 'user');
    criarCard(ultimoLead, ultimaUser?.content.slice(0, 120) ?? 'Veio da triagem do assistente.');
  }

  function limpar() {
    reset();
    setCardCriadoNome(null);
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
            onClick={mandarProCRM}
            disabled={messages.length === 0 || leadCriado}
            title={leadCriado ? 'Ficha já enviada ao painel' : 'Criar a ficha no painel com os dados da conversa'}
            className="rounded-lg bg-cyan-dark px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-cyan-dark/90 disabled:opacity-40"
          >
            {leadCriado ? '✓ no painel' : 'Virou paciente → CRM'}
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
            Converse como se fosse alguém chegando no WhatsApp da clínica. A assistente acolhe, faz a
            triagem e, ao final, cria a ficha no painel automaticamente.
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
        {cardCriadoNome && (
          <div className="pop-in mx-auto mt-1 w-full max-w-sm rounded-2xl border border-cyan-dark/30 bg-gradient-to-br from-cyan/10 to-surface-2 p-4 shadow-sm">
            <div className="flex items-center gap-2">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-cyan-dark text-white">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
              </span>
              <div className="text-sm font-semibold text-navy">Ficha criada no painel</div>
            </div>
            <p className="mt-2 text-[13px] leading-relaxed text-ink-muted">
              A triagem de <span className="font-semibold text-navy">{cardCriadoNome}</span> caiu na
              coluna <span className="font-medium text-cyan-dark">Triagem concluída</span>, pronta pra
              equipe distribuir pra uma psicóloga.
            </p>
            {onGoToBoard && (
              <button
                onClick={onGoToBoard}
                className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-navy px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-navy-2"
              >
                Ver no painel
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              </button>
            )}
          </div>
        )}
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
