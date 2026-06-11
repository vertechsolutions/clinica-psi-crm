'use client';
import { useState } from 'react';
import { useDraggable } from '@dnd-kit/core';
import type { Paciente, Preferencia, FichaTriagem } from '@/types';
import { fmtData } from '@/lib/datetime';
import { useKanban } from '@/stores/kanban-store';

const prefChip: Record<Preferencia, { label: string; cls: string }> = {
  F: { label: '♀ prefere mulher', cls: 'bg-pink/10 text-pink' },
  M: { label: '♂ prefere homem', cls: 'bg-blue/10 text-blue' },
  indiferente: { label: 'tanto faz', cls: 'bg-ink-muted/10 text-ink-muted' },
};

/** linha label: valor da ficha de triagem, escondida quando vazia */
function FichaLinha({ label, valor }: { label: string; valor?: string | null }) {
  if (!valor) return null;
  return (
    <div className="flex gap-1.5 text-[11.5px] leading-snug">
      <span className="shrink-0 font-semibold text-ink-muted">{label}:</span>
      <span className="text-ink">{valor}</span>
    </div>
  );
}

/** true se a ficha tem algo alem do resumo pra mostrar */
function temFicha(t?: FichaTriagem): boolean {
  if (!t) return false;
  return Boolean(
    t.motivacao ||
      t.expectativa ||
      (t.sintomas && t.sintomas.length) ||
      t.diagnostico ||
      t.terapiaAnterior ||
      t.preferenciaAbordagem ||
      t.disponibilidade ||
      t.dataNascimento ||
      t.email ||
      t.telefone ||
      t.contatoEmergencia ||
      t.profissao ||
      t.statusRelacionamento ||
      t.filhos ||
      t.vicios ||
      t.notaFiscal ||
      t.observacoes,
  );
}

export function PatientCard({ paciente, overlay = false }: { paciente: Paciente; overlay?: boolean }) {
  const unassign = useKanban((s) => s.unassign);
  const marcarPago = useKanban((s) => s.marcarPago);
  const [aberto, setAberto] = useState(false);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: overlay ? `ov-${paciente.id}` : paciente.id,
    disabled: overlay,
  });
  const ficha = paciente.triagem;
  const mostraFicha = !overlay && temFicha(ficha);
  const pref = prefChip[paciente.preferencia];
  const alocado = paciente.psicologaId !== null;
  const naoPago = !paciente.pago;
  const modalidadeLabel =
    paciente.modalidade === 'pacote'
      ? `pacote${paciente.frequenciaSemanal ? ` ${paciente.frequenciaSemanal}x/sem` : ''}${
          paciente.duracaoMeses ? ` · ${paciente.duracaoMeses}m` : ''
        }`
      : paciente.modalidade;

  // overflow-hidden faz as camadas decorativas do "não pago" (wash + faixa lateral)
  // acompanharem o canto arredondado, sem vazar.
  const base = 'relative w-60 shrink-0 overflow-hidden rounded-2xl border p-4 transition-all';
  const tone = naoPago ? 'border-[#ef4444]/35 bg-surface' : 'border-line bg-surface';
  const cls = overlay
    ? `${base} ${tone} rotate-[3deg] scale-[1.04] shadow-2xl ring-2 ring-cyan-dark/30`
    : isDragging
      ? `${base} ${tone} opacity-30`
      : `${base} ${tone} shadow-sm hover:-translate-y-0.5 hover:shadow-md`;

  return (
    <div ref={overlay ? undefined : setNodeRef} className={cls}>
      {naoPago && (
        <>
          {/* wash diagonal suave do canto superior, some antes do texto */}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                'linear-gradient(155deg, rgba(239,68,68,0.09) 0%, rgba(239,68,68,0.025) 42%, rgba(239,68,68,0) 72%)',
            }}
          />
          {/* faixa de status na borda esquerda, encaixada pela curva via overflow-hidden */}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 left-0 w-1.5"
            style={{ background: 'linear-gradient(to bottom, #f87171, #ef4444)' }}
          />
        </>
      )}

      <div
        {...(overlay ? {} : listeners)}
        {...(overlay ? {} : attributes)}
        className={`relative z-10 ${overlay ? 'cursor-grabbing' : 'cursor-grab touch-none active:cursor-grabbing'}`}
      >
        <div className="flex items-start justify-between gap-2 pl-1">
          <span className="text-[15px] font-semibold leading-tight text-navy">{paciente.nome}</span>
          <span className="mt-0.5 shrink-0 rounded-md bg-[#25D366]/[0.12] px-1.5 py-0.5 text-[10px] font-semibold text-[#0e8a43]">
            {paciente.origem}
          </span>
        </div>
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 pl-1">
          {naoPago && (
            <span className="inline-flex items-center gap-1.5 rounded-md bg-[#ef4444]/12 px-2 py-0.5 text-[11px] font-semibold text-[#dc2626]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#ef4444]" />
              não pago ainda
            </span>
          )}
          <span className={`rounded-md px-2 py-0.5 text-[11px] font-medium ${pref.cls}`}>{pref.label}</span>
          <span className="rounded-md bg-navy/5 px-2 py-0.5 text-[11px] font-medium text-ink-muted">
            {modalidadeLabel}
          </span>
        </div>
        <p className="mt-2.5 line-clamp-2 pl-1 text-[13px] leading-relaxed text-ink-muted">{paciente.resumo}</p>
        {paciente.agendamentoIso && (
          <div className="mt-3 ml-1 flex w-fit items-center gap-1.5 rounded-lg bg-cyan-dark/10 px-2.5 py-1.5 text-[12px] font-semibold text-cyan-dark">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="18" rx="2" />
              <path d="M16 2v4M8 2v4M3 10h18" />
            </svg>
            {fmtData(paciente.agendamentoIso)}
            {paciente.sessaoTotal && paciente.sessaoTotal > 1 && (
              <span className="ml-0.5 rounded bg-cyan-dark/15 px-1.5 py-px text-[11px] font-bold">
                {paciente.sessaoNum}/{paciente.sessaoTotal}
              </span>
            )}
          </div>
        )}
      </div>

      {mostraFicha && (
        <div className="relative z-10 ml-1 mt-2.5">
          <button
            onClick={() => setAberto((v) => !v)}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold text-cyan-dark transition-colors hover:bg-cyan/10"
          >
            {aberto ? 'Ocultar triagem' : 'Ver triagem'}
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={`transition-transform ${aberto ? 'rotate-180' : ''}`}
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
          {aberto && ficha && (
            <div className="fade-in mt-2 space-y-1 rounded-xl border border-line bg-surface-2/70 p-2.5">
              <FichaLinha label="Motivação" valor={ficha.motivacao} />
              {ficha.sintomas && ficha.sintomas.length > 0 && (
                <div className="flex flex-wrap gap-1 py-0.5">
                  {ficha.sintomas.map((s) => (
                    <span
                      key={s}
                      className="rounded-md bg-cyan-dark/10 px-1.5 py-0.5 text-[10.5px] font-medium text-cyan-dark"
                    >
                      {s}
                    </span>
                  ))}
                </div>
              )}
              <FichaLinha label="Diagnóstico" valor={ficha.diagnostico} />
              <FichaLinha label="Já fez terapia" valor={ficha.terapiaAnterior} />
              <FichaLinha label="Expectativa" valor={ficha.expectativa} />
              <FichaLinha label="Abordagem" valor={ficha.preferenciaAbordagem} />
              <FichaLinha label="Disponibilidade" valor={ficha.disponibilidade} />
              <FichaLinha label="Profissão" valor={ficha.profissao} />
              <FichaLinha label="Relacionamento" valor={ficha.statusRelacionamento} />
              <FichaLinha label="Filhos" valor={ficha.filhos} />
              <FichaLinha label="Vícios" valor={ficha.vicios} />
              <FichaLinha label="Nascimento" valor={ficha.dataNascimento} />
              <FichaLinha label="E-mail" valor={ficha.email} />
              <FichaLinha label="Telefone" valor={ficha.telefone} />
              <FichaLinha label="Emergência" valor={ficha.contatoEmergencia} />
              <FichaLinha label="Nota fiscal" valor={ficha.notaFiscal} />
              <FichaLinha label="Obs." valor={ficha.observacoes} />
            </div>
          )}
        </div>
      )}

      {naoPago && !overlay && (
        <button
          onClick={() => marcarPago(paciente.grupoId ?? paciente.id)}
          className="relative z-10 mt-3 ml-1 flex w-[calc(100%-0.25rem)] items-center justify-center gap-1.5 rounded-lg border border-[#ef4444]/30 bg-[#ef4444]/[0.04] py-1.5 text-[11px] font-semibold text-[#dc2626] transition-all hover:border-[#16a34a]/45 hover:bg-[#16a34a]/[0.08] hover:text-[#16a34a]"
          title="Marcar como pago"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6L9 17l-5-5" />
          </svg>
          marcar como pago
        </button>
      )}

      {alocado && !overlay && (
        <button
          onClick={() => unassign(paciente.id)}
          className="absolute right-1.5 top-1.5 z-20 flex h-6 w-6 items-center justify-center rounded-full border border-line bg-surface/90 text-ink-muted shadow-sm backdrop-blur transition-colors hover:border-pink hover:text-pink"
          title="Devolver pra não alocados"
        >
          ×
        </button>
      )}
    </div>
  );
}
