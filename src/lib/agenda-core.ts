/**
 * Núcleo PURO da agenda: transforma as linhas cruas das abas do Google Sheets
 * (planilha "Cazule — Agenda") em estruturas e num resumo textual que a Camila
 * injeta no prompt pra propor horários reais. Sem I/O — testável com fixtures.
 * Abas esperadas: "Psicólogas", "Grade Semanal", "Agenda" (ver planilha modelo).
 */
export const DIAS = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'] as const;
export type Dia = (typeof DIAS)[number];
export type Modalidade = 'Individual' | 'Casal' | 'Infanto-juvenil';

export interface Psicologa {
  nome: string;
  crp: string;
  abordagens: string;
  individual: boolean;
  casal: boolean;
  infanto: boolean;
  prefGenero: string;
  obs: string;
}
export interface GradeRow {
  nome: string;
  janelas: Partial<Record<Dia, string>>;
}
export interface AgendaRow {
  data: string;
  hora: string;
  paciente: string;
  whatsapp: string;
  psicologa: string;
  modalidade: string;
  tipo: string;
  status: string;
  valor: string;
  pagamento: string;
  nf: string;
  obs: string;
}
export interface AgendaData {
  psicologas: Psicologa[];
  grade: GradeRow[];
  agenda: AgendaRow[];
}

const cell = (r: string[], i: number) => (r[i] ?? '').toString().trim();
const sim = (v: string) => /^s/i.test(v.trim()); // "Sim" -> true, "Não" -> false

export function parsePsicologas(rows: string[][]): Psicologa[] {
  return rows
    .slice(1)
    .filter((r) => cell(r, 0))
    .map((r) => ({
      nome: cell(r, 0),
      crp: cell(r, 1),
      abordagens: cell(r, 2),
      individual: sim(cell(r, 3)),
      casal: sim(cell(r, 4)),
      infanto: sim(cell(r, 5)),
      prefGenero: cell(r, 6),
      obs: cell(r, 7),
    }));
}

export function parseGrade(rows: string[][]): GradeRow[] {
  return rows
    .slice(1)
    .filter((r) => cell(r, 0))
    .map((r) => {
      const janelas: Partial<Record<Dia, string>> = {};
      DIAS.forEach((d, i) => {
        const v = cell(r, i + 1);
        if (v && v !== '-') janelas[d] = v;
      });
      return { nome: cell(r, 0), janelas };
    });
}

export function parseAgenda(rows: string[][]): AgendaRow[] {
  return rows
    .slice(1)
    .filter((r) => cell(r, 0))
    .map((r) => ({
      data: cell(r, 0),
      hora: cell(r, 1),
      paciente: cell(r, 2),
      whatsapp: cell(r, 3),
      psicologa: cell(r, 4),
      modalidade: cell(r, 5),
      tipo: cell(r, 6),
      status: cell(r, 7),
      valor: cell(r, 8),
      pagamento: cell(r, 9),
      nf: cell(r, 10),
      obs: cell(r, 11),
    }));
}

function capaz(p: Psicologa, mod?: Modalidade): boolean {
  if (mod === 'Casal') return p.casal;
  if (mod === 'Infanto-juvenil') return p.infanto;
  return p.individual; // default: individual
}

/**
 * Resumo compacto (bounded) da agenda pra injetar no system prompt. Lista as
 * psicólogas elegíveis à modalidade com suas janelas fixas, e os horários já
 * reservados (sem vazar nome do paciente — só data/hora/psicóloga/modalidade).
 * Cancelados são ignorados.
 */
export function resumoDisponibilidade(
  data: AgendaData,
  opts: { modalidade?: Modalidade } = {},
): string {
  const { psicologas, grade, agenda } = data;
  const mod = opts.modalidade;
  const gradeByNome = new Map(grade.map((g) => [g.nome, g.janelas]));

  const linhas = psicologas
    .filter((p) => capaz(p, mod))
    .map((p) => {
      const jan = gradeByNome.get(p.nome) ?? {};
      const dias = DIAS.filter((d) => jan[d]).map((d) => `${d.slice(0, 3).toLowerCase()} ${jan[d]}`);
      if (!dias.length) return null;
      return `- ${p.nome} (${p.abordagens}): ${dias.join(', ')}`;
    })
    .filter((x): x is string => Boolean(x));

  const ocupados = agenda
    .filter((a) => a.status.toLowerCase() !== 'cancelada' && a.data && a.hora)
    .slice(0, 12)
    .map((a) => `${a.data} ${a.hora} ${a.psicologa}${a.modalidade ? ` (${a.modalidade})` : ''}`);

  const titulo = mod ? mod.toLowerCase() : 'individual';
  return [
    '[AGENDA DA CLÍNICA — fonte: planilha. Use para SUGERIR um horário concreto e depois confirmar. NUNCA invente horário fora desta lista nem prometa sem confirmar.]',
    `Psicólogas que atendem ${titulo} e suas janelas fixas:`,
    ...(linhas.length ? linhas : ['- (nenhuma janela cadastrada — deixe a equipe confirmar)']),
    ocupados.length ? `Já reservado (não ofereça esses): ${ocupados.join('; ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
