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
  cor: string; // hex do avatar
  iniciais: string;
  agenda: Slot[]; // horários livres
}

export interface Paciente {
  id: string;
  nome: string;
  origem: 'WhatsApp';
  preferencia: Preferencia;
  modalidade: Modalidade;
  resumo: string; // resumo da triagem
  psicologaId: string | null;
  agendamentoIso: string | null;
}
