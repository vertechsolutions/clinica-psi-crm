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
