export type Sexo = 'F' | 'M';
export type Preferencia = 'F' | 'M' | 'indiferente';
export type Modalidade = 'avulso' | 'pacote';

export interface Slot {
  id: string;
  iso: string; // ex: "2026-06-10T14:00"
}

export interface Psicologa {
  id: string;
  nome: string;
  sexo: Sexo;
  especialidade: string;
  cor: string; // hex do avatar (fallback)
  iniciais: string;
  foto?: string; // URL da foto (com fallback pras iniciais)
  agenda: Slot[];
}

export interface Paciente {
  id: string;
  nome: string;
  origem: 'WhatsApp';
  preferencia: Preferencia;
  modalidade: Modalidade;
  resumo: string;
  psicologaId: string | null;
  agendamentoIso: string | null;
}
