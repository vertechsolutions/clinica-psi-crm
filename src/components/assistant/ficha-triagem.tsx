'use client';
import type { LeadExtraido } from '@/lib/triagem';

/** Um campo da ficha, só renderiza se tiver valor. */
function Campo({ rotulo, valor }: { rotulo: string; valor: string | null | undefined }) {
  if (!valor || !valor.trim()) return null;
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted">{rotulo}</span>
      <span className="text-[13px] leading-snug text-ink">{valor}</span>
    </div>
  );
}

const PREF_LABEL: Record<string, string> = {
  F: 'psicóloga (mulher)',
  M: 'psicólogo (homem)',
  indiferente: 'indiferente',
};

/**
 * Mostra a ficha de triagem que a IA foi montando ao longo da conversa. É read-only:
 * serve pra você e o Jean verem o que o assistente conseguiu captar (calibração do
 * raciocínio). Numa fase futura, esses campos alimentam o formulário da psicóloga.
 */
export function FichaTriagem({ lead, pronto }: { lead: LeadExtraido | null; pronto: boolean }) {
  if (!lead) return null;

  const temAlgo = Object.entries(lead).some(([k, v]) => {
    if (k === 'sintomas') return Array.isArray(v) && v.length > 0;
    return typeof v === 'string' && v.trim();
  });
  if (!temAlgo) return null;

  return (
    <div className="pop-in rounded-2xl border border-line bg-surface p-4 shadow-sm">
      <div className="mb-3 flex items-center gap-2">
        <span className="flex h-6 items-center rounded-md bg-navy/5 px-2 text-[10px] font-bold uppercase tracking-wide text-cyan-dark">
          ficha de triagem
        </span>
        {pronto && (
          <span className="flex items-center gap-1 rounded-full bg-[#25D366]/12 px-2 py-0.5 text-[10px] font-semibold text-[#0e8a43]">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
            pronta pra agendar
          </span>
        )}
      </div>

      {lead.resumo && (
        <p className="mb-3 rounded-lg bg-surface-2 px-3 py-2 text-[13px] italic leading-snug text-ink">
          “{lead.resumo}”
        </p>
      )}

      <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
        <Campo rotulo="Nome" valor={lead.nome} />
        <Campo rotulo="Nascimento" valor={lead.dataNascimento} />
        <Campo rotulo="Telefone" valor={lead.telefone} />
        <Campo rotulo="E-mail" valor={lead.email} />
        <Campo rotulo="Contato emergência" valor={lead.contatoEmergencia} />
        <Campo rotulo="Profissão" valor={lead.profissao} />
        <Campo rotulo="Disponibilidade" valor={lead.disponibilidade} />
        <Campo rotulo="Preferência" valor={lead.preferencia ? PREF_LABEL[lead.preferencia] : null} />
        <Campo rotulo="Abordagem" valor={lead.preferenciaAbordagem} />
        <Campo rotulo="Estado civil" valor={lead.statusRelacionamento} />
        <Campo rotulo="Filhos" valor={lead.filhos} />
        <Campo rotulo="Diagnóstico" valor={lead.diagnostico} />
        <Campo rotulo="Terapia anterior" valor={lead.terapiaAnterior} />
        <Campo rotulo="Vícios" valor={lead.vicios} />
      </div>

      {(lead.motivacao || lead.expectativa || (lead.sintomas?.length ?? 0) > 0 || lead.observacoes || lead.notaFiscal) && (
        <div className="mt-3 flex flex-col gap-2.5 border-t border-line pt-3">
          <Campo rotulo="Motivação" valor={lead.motivacao} />
          <Campo rotulo="Expectativa" valor={lead.expectativa} />
          {lead.sintomas?.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted">Temas identificados</span>
              <div className="flex flex-wrap gap-1">
                {lead.sintomas.map((s) => (
                  <span key={s} className="rounded-full bg-cyan/10 px-2 py-0.5 text-[11px] font-medium text-cyan-dark">
                    {s}
                  </span>
                ))}
              </div>
            </div>
          )}
          <Campo rotulo="Observações" valor={lead.observacoes} />
          <Campo rotulo="Nota fiscal" valor={lead.notaFiscal} />
        </div>
      )}
    </div>
  );
}
