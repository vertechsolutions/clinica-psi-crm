'use client';
import { useEffect, useState } from 'react';
import { useKanban } from '@/stores/kanban-store';
import { fmtData, fmtDiaSemana, ocorrenciasSemanais } from '@/lib/datetime';
import { Avatar } from '../avatar';

export function SchedulePopup() {
  const pending = useKanban((s) => s.pending);
  const psicologas = useKanban((s) => s.psicologas);
  const confirm = useKanban((s) => s.confirmSchedule);
  const close = useKanban((s) => s.closeSchedule);
  const [sel, setSel] = useState<string[]>([]);

  const freq = pending?.frequencia ?? 1;
  const meses = pending?.meses ?? 0;
  const isPacote = meses > 0;
  const precisaVariosDias = freq > 1;

  // zera a seleção sempre que abre pra outro card/psicóloga
  useEffect(() => {
    setSel([]);
  }, [pending?.cardId, pending?.psicologaId]);

  if (!pending) return null;
  const psi = psicologas.find((p) => p.id === pending.psicologaId);
  if (!psi) return null;

  const diasDistintos = new Set(sel.map((iso) => iso.slice(0, 10))).size;
  const completo = sel.length === freq;
  // total real de sessões após expandir a recorrência semanal pelos meses do pacote
  const totalSessoes = sel.flatMap((iso) => ocorrenciasSemanais(iso, meses)).length;

  function onSlot(iso: string) {
    if (!isPacote) {
      confirm([iso]); // avulso: clique direto agenda 1 sessão
      return;
    }
    setSel((cur) =>
      cur.includes(iso) ? cur.filter((x) => x !== iso) : cur.length < freq ? [...cur, iso] : cur,
    );
  }

  return (
    <div
      className="fade-in fixed inset-0 z-50 flex items-center justify-center bg-navy/50 p-4 backdrop-blur-sm"
      onClick={close}
    >
      <div
        className="pop-in w-full max-w-md rounded-2xl bg-surface p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3">
          <Avatar src={psi.foto} iniciais={psi.iniciais} cor={psi.cor} size={44} />
          <div className="min-w-0">
            <div className="text-base font-semibold text-navy">{psi.nome}</div>
            <div className="truncate text-xs text-ink-muted">
              {psi.especialidade} ·{' '}
              {isPacote
                ? precisaVariosDias
                  ? `escolha ${freq} horários base`
                  : 'escolha o horário base'
                : 'escolha o horário'}
            </div>
          </div>
          <button onClick={close} className="ml-auto text-2xl leading-none text-ink-muted hover:text-navy">
            ×
          </button>
        </div>

        {isPacote && (
          <div className="mt-4 flex items-center justify-between rounded-xl bg-cyan/5 px-3 py-2 text-xs">
            <span className="font-medium text-navy">
              Pacote {freq}x/sem · {meses} {meses > 1 ? 'meses' : 'mês'}
              {precisaVariosDias ? ` · ${freq} dias distintos` : ''}
            </span>
            <span className={`font-semibold ${completo ? 'text-[#16a34a]' : 'text-cyan-dark'}`}>
              {sel.length}/{freq}
            </span>
          </div>
        )}

        <div className="mt-4 grid grid-cols-2 gap-2.5">
          {psi.agenda.length === 0 && (
            <p className="col-span-2 rounded-xl bg-surface-2 p-4 text-center text-sm text-ink-muted">
              Sem horários livres pra essa psicóloga.
            </p>
          )}
          {psi.agenda
            .slice()
            .sort((a, b) => a.iso.localeCompare(b.iso))
            .map((slot) => {
              const ativo = sel.includes(slot.iso);
              return (
                <button
                  key={slot.id}
                  onClick={() => onSlot(slot.iso)}
                  className={`group rounded-xl border px-3 py-2.5 text-left transition-all hover:-translate-y-0.5 hover:shadow-sm ${
                    ativo
                      ? 'border-cyan-dark bg-cyan/10 ring-1 ring-cyan-dark/40'
                      : 'border-line bg-surface-2 hover:border-cyan-dark hover:bg-cyan/5'
                  }`}
                >
                  <div className={`text-sm font-semibold ${ativo ? 'text-cyan-dark' : 'text-navy group-hover:text-cyan-dark'}`}>
                    {fmtDiaSemana(slot.iso)}
                    {ativo && ' ✓'}
                  </div>
                  <div className="text-xs text-ink-muted">{fmtData(slot.iso)}</div>
                </button>
              );
            })}
        </div>

        {precisaVariosDias && completo && diasDistintos < freq && (
          <p className="mt-3 rounded-lg bg-amber-400/10 px-3 py-2 text-[12px] font-medium text-amber-600">
            Dica: pra um pacote {freq}x/semana, escolha {freq} dias diferentes.
          </p>
        )}

        {isPacote && (
          <button
            onClick={() => confirm(sel)}
            disabled={!completo}
            className="mt-4 w-full rounded-xl bg-cyan-dark py-2.5 text-sm font-semibold text-white transition-colors hover:bg-cyan-dark/90 disabled:opacity-40"
          >
            {completo
              ? `Agendar ${totalSessoes} sessões no mesmo horário`
              : `Selecione ${freq - sel.length} horário(s)`}
          </button>
        )}

        <button
          onClick={close}
          className="mt-2 w-full rounded-xl py-2.5 text-sm text-ink-muted transition-colors hover:bg-surface-2 hover:text-navy"
        >
          Cancelar
        </button>
      </div>
    </div>
  );
}
