import type { Psicologa, Paciente } from '@/types';
import { slotIso } from './datetime';

export function buildPsicologas(): Psicologa[] {
  const mk = (
    id: string,
    nome: string,
    sexo: 'F' | 'M',
    esp: string,
    cor: string,
    foto: string,
    offs: [number, number][],
  ): Psicologa => ({
    id,
    nome,
    sexo,
    especialidade: esp,
    cor,
    foto,
    iniciais:
      nome
        .split(' ')
        .slice(1, 3)
        .map((s) => s[0])
        .join('') || nome[0],
    agenda: offs.map(([d, h], i) => ({ id: `${id}-s${i}`, iso: slotIso(d, h) })),
  });

  const ru = (g: 'women' | 'men', n: number) => `https://randomuser.me/api/portraits/${g}/${n}.jpg`;

  return [
    mk('p1', 'Dra. Helena Castro', 'F', 'Ansiedade · TCC', '#0891b2', ru('women', 44), [[1, 9], [1, 14], [3, 10]]),
    mk('p2', 'Dra. Camila Rocha', 'F', 'Infantil', '#7c3aed', ru('women', 68), [[2, 8], [2, 15], [4, 11]]),
    mk('p3', 'Dr. Bruno Antunes', 'M', 'Depressão', '#2563eb', ru('men', 32), [[1, 16], [3, 9], [5, 14]]),
    mk('p4', 'Dra. Patrícia Lemos', 'F', 'Luto · Casal', '#db2777', ru('women', 65), [[2, 10], [4, 16]]),
    mk('p5', 'Dra. Juliana Maia', 'F', 'TCC · Pânico', '#0d9488', ru('women', 12), [[1, 11], [3, 15], [5, 9]]),
    mk('p6', 'Dr. André Pires', 'M', 'Dependências', '#4f46e5', ru('men', 45), [[2, 14], [4, 9]]),
    mk('p7', 'Dra. Marina Goulart', 'F', 'Adolescentes', '#c026d3', ru('women', 90), [[1, 8], [3, 17], [5, 11]]),
    mk('p8', 'Dr. Felipe Nunes', 'M', 'Carreira', '#1d4ed8', ru('men', 76), [[2, 9], [4, 14]]),
  ];
}

export function buildPacientes(): Paciente[] {
  return [
    { id: 'c1', nome: 'Mariana S.', origem: 'WhatsApp', preferencia: 'F', modalidade: 'pacote', resumo: 'Ansiedade no trabalho, quer pacote mensal. Prefere mulher.', psicologaId: null, agendamentoIso: null },
    { id: 'c2', nome: 'João P.', origem: 'WhatsApp', preferencia: 'indiferente', modalidade: 'avulso', resumo: 'Sessão avulsa pra experimentar. Sem preferência.', psicologaId: null, agendamentoIso: null },
    { id: 'c3', nome: 'Rafaela M.', origem: 'WhatsApp', preferencia: 'F', modalidade: 'pacote', resumo: 'Luto recente. Quer começar essa semana.', psicologaId: null, agendamentoIso: null },
    { id: 'c4', nome: 'Lucas D.', origem: 'WhatsApp', preferencia: 'M', modalidade: 'avulso', resumo: 'Quer psicólogo homem, tema carreira.', psicologaId: null, agendamentoIso: null },
    { id: 'c5', nome: 'Beatriz F.', origem: 'WhatsApp', preferencia: 'indiferente', modalidade: 'pacote', resumo: 'Pânico, urgência média.', psicologaId: null, agendamentoIso: null },
    { id: 'c6', nome: 'Carla T.', origem: 'WhatsApp', preferencia: 'F', modalidade: 'pacote', resumo: 'Em acompanhamento.', psicologaId: 'p1', agendamentoIso: null },
    { id: 'c7', nome: 'Diego R.', origem: 'WhatsApp', preferencia: 'M', modalidade: 'avulso', resumo: 'Retorno.', psicologaId: 'p3', agendamentoIso: null },
  ];
}
