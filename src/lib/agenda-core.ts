/**
 * Núcleo PURO da agenda: transforma as linhas cruas das abas do Google Sheets
 * (planilha "Cazule — Agenda") em estruturas e num resumo textual que a Camila
 * injeta no prompt pra propor horários reais. Sem I/O — testável com fixtures.
 * Abas esperadas: "Psicólogas", "Grade Semanal", "Agenda" (ver planilha modelo).
 */
export const DIAS = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'] as const;
export type Dia = (typeof DIAS)[number];

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
/** Sanitiza texto da planilha antes de injetar no prompt (anti prompt-injection). */
const limpa = (s: string) => s.replace(/[\r\n[\]]/g, ' ').trim().slice(0, 120);

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

/** Converte "dd/mm/yyyy" em Date (meia-noite local); null se não parsear. */
function parseDataBR(s: string): Date | null {
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface ResumoOpts {
  /** data de referência pra descartar reservas passadas (default: agora). Injetável nos testes. */
  hoje?: Date;
}

/**
 * Resumo compacto (bounded) da agenda pra injetar no system prompt. Lista TODAS
 * as psicólogas com janelas, marcando o que cada uma atende (individual/casal/
 * infanto) — a conversa pode ser de qualquer modalidade e o modelo escolhe pela
 * tag. Reservas: sem nome de paciente (só data/hora/psicóloga/modalidade),
 * canceladas ignoradas, datas passadas descartadas.
 */
const DIAS_SEMANA = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

export function resumoDisponibilidade(data: AgendaData, opts: ResumoOpts = {}): string {
  const { psicologas, grade, agenda } = data;
  const hoje = opts.hoje ?? new Date();
  const hojeZero = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
  const gradeByNome = new Map(grade.map((g) => [g.nome, g.janelas]));
  const dd = String(hojeZero.getDate()).padStart(2, '0');
  const mm = String(hojeZero.getMonth() + 1).padStart(2, '0');
  // O modelo precisa da data de referência pra relacionar dd/mm com dia da semana.
  const linhaHoje = `Hoje é ${DIAS_SEMANA[hojeZero.getDay()]}, ${dd}/${mm}/${hojeZero.getFullYear()}.`;

  const linhas = psicologas
    .map((p) => {
      const jan = gradeByNome.get(p.nome) ?? {};
      const dias = DIAS.filter((d) => jan[d]).map((d) => `${d.slice(0, 3).toLowerCase()} ${limpa(jan[d] as string)}`);
      if (!dias.length) return null;
      const tags = [
        p.individual ? 'individual' : null,
        p.casal ? 'casal' : null,
        p.infanto ? 'infanto 13+' : null,
      ]
        .filter(Boolean)
        .join(', ');
      return `- ${limpa(p.nome)} (${limpa(p.abordagens)}; atende: ${tags || 'a confirmar'}): ${dias.join(', ')}`;
    })
    .filter((x): x is string => Boolean(x));

  const ocupados = agenda
    .filter((a) => {
      if (!a.data || !a.hora) return false;
      if (a.status.toLowerCase().startsWith('cancela')) return false;
      const d = parseDataBR(a.data);
      // sem parse: mantém (conservador — melhor bloquear de mais que oferecer slot ocupado)
      return d === null || d >= hojeZero;
    })
    .slice(0, 12)
    .map((a) => `${limpa(a.data)} ${limpa(a.hora)} ${limpa(a.psicologa)}${a.modalidade ? ` (${limpa(a.modalidade)})` : ''}`);

  return [
    '[AGENDA DA CLÍNICA — fonte: planilha. Use para SUGERIR um horário concreto com uma psicóloga cuja tag bate com a modalidade do paciente (individual/casal/infanto) e depois confirme. NUNCA invente horário fora desta lista nem prometa sem confirmar.]',
    linhaHoje,
    'Psicólogas, o que cada uma atende e janelas fixas:',
    ...(linhas.length ? linhas : ['- (nenhuma janela cadastrada — deixe a equipe confirmar)']),
    ocupados.length ? `Já reservado (não ofereça esses): ${ocupados.join('; ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
