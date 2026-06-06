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
  /** false enquanto o cliente não pagou (card fica vermelho + tag "não pago") */
  pago: boolean;
  /** sessões por semana quando modalidade === 'pacote' */
  frequenciaSemanal?: number;
  /** liga os cards-sessão gerados a partir de um mesmo pacote */
  grupoId?: string;
}
