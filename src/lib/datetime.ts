export function fmtData(iso: string): string {
  const d = new Date(iso);
  return (
    d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) +
    ' · ' +
    d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  );
}

export function fmtDiaSemana(iso: string): string {
  const d = new Date(iso);
  const dia = d.toLocaleDateString('pt-BR', { weekday: 'short' });
  return dia.charAt(0).toUpperCase() + dia.slice(1);
}

export function isPassado(iso: string | null): boolean {
  if (!iso) return false;
  return new Date(iso).getTime() < Date.now();
}

// gera "hoje + dayOffset" às HH:00 em ISO local (sem timezone Z)
export function slotIso(dayOffset: number, hour: number): string {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, 0, 0, 0);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(hour)}:00`;
}

// soma N dias a um ISO local preservando hora/minuto
export function addDiasIso(iso: string, dias: number): string {
  const d = new Date(iso);
  d.setDate(d.getDate() + dias);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * A partir de um horário base (dia da semana + hora), gera as ocorrências
 * semanais no MESMO horário até completar `meses` de pacote. Inclui o próprio
 * isoInicial. meses<=0 → só o horário base (avulso). Teto de 27 (~6 meses) por
 * segurança pra não travar a UI.
 */
export function ocorrenciasSemanais(isoInicial: string, meses: number): string[] {
  if (meses <= 0) return [isoInicial];
  const limite = new Date(isoInicial);
  limite.setMonth(limite.getMonth() + meses);
  const out: string[] = [];
  let atual = isoInicial;
  for (let i = 0; i < 27 && new Date(atual).getTime() <= limite.getTime(); i++) {
    out.push(atual);
    atual = addDiasIso(atual, 7);
  }
  return out;
}
