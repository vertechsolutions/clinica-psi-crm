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
    {
      id: 'c1', nome: 'Mariana S.', origem: 'WhatsApp', preferencia: 'F', modalidade: 'pacote', frequenciaSemanal: 2, duracaoMeses: 3,
      resumo: 'Ansiedade ligada ao trabalho, busca acompanhamento.', psicologaId: null, agendamentoIso: null, pago: true,
      triagem: {
        motivacao: 'Ansiosa por causa do trabalho, não consegue desligar à noite.',
        sintomas: ['humor ansioso', 'questoes no trabalho', 'baixa autoestima'],
        diagnostico: 'Ansiedade (já em uso de medicação).',
        terapiaAnterior: 'Nunca fez terapia antes.',
        expectativa: 'Sentir-se mais tranquila e dormir melhor.',
        preferenciaAbordagem: 'Prefere mulher; aberta a TCC.',
        disponibilidade: 'Terça e quinta à tarde.',
        profissao: 'Advogada', telefone: '(11) 98888-7777', email: 'mari.souza@email.com',
        statusRelacionamento: 'casado', filhos: '1',
      },
    },
    {
      id: 'c2', nome: 'João P.', origem: 'WhatsApp', preferencia: 'indiferente', modalidade: 'avulso',
      resumo: 'Autoconhecimento; primeira vez na terapia.', psicologaId: null, agendamentoIso: null, pago: false,
      triagem: {
        motivacao: 'Quer se entender melhor e tomar decisões com mais clareza.',
        sintomas: ['autoconhecimento'], terapiaAnterior: 'Primeira vez.',
        disponibilidade: 'Quartas à noite.', profissao: 'Analista de TI', telefone: '(11) 96666-5555',
        statusRelacionamento: 'solteiro', filhos: 'nao',
      },
    },
    {
      id: 'c3', nome: 'Rafaela M.', origem: 'WhatsApp', preferencia: 'F', modalidade: 'pacote', frequenciaSemanal: 1, duracaoMeses: 2,
      resumo: 'Luto recente, quer começar essa semana.', psicologaId: null, agendamentoIso: null, pago: true,
      triagem: {
        motivacao: 'Perda de um familiar próximo há poucas semanas.',
        sintomas: ['luto', 'humor depressivo'], expectativa: 'Conseguir atravessar o luto com apoio.',
        preferenciaAbordagem: 'Prefere mulher.', disponibilidade: 'Sextas de manhã.',
        contatoEmergencia: 'Irmã — (21) 95555-4444', telefone: '(21) 97777-6666',
        statusRelacionamento: 'casado', filhos: '2',
      },
    },
    {
      id: 'c4', nome: 'Lucas D.', origem: 'WhatsApp', preferencia: 'M', modalidade: 'avulso',
      resumo: 'Questões de carreira e propósito.', psicologaId: null, agendamentoIso: null, pago: true,
      triagem: {
        motivacao: 'Insatisfeito com a carreira, pensando em mudar de área.',
        sintomas: ['questoes no trabalho', 'autoconhecimento'], preferenciaAbordagem: 'Prefere psicólogo homem.',
        disponibilidade: 'Segundas à tarde.', profissao: 'Engenheiro', telefone: '(48) 99111-2222',
        statusRelacionamento: 'namorando', filhos: 'nao',
      },
    },
    {
      id: 'c5', nome: 'Beatriz F.', origem: 'WhatsApp', preferencia: 'indiferente', modalidade: 'pacote', frequenciaSemanal: 2, duracaoMeses: 2,
      resumo: 'Crises de pânico, urgência média.', psicologaId: null, agendamentoIso: null, pago: false,
      triagem: {
        motivacao: 'Crises de pânico que pioraram nos últimos meses.',
        sintomas: ['humor ansioso', 'dependencia emocional'], diagnostico: 'Síndrome do pânico (a confirmar).',
        terapiaAnterior: 'Fez por 6 meses, parou.', expectativa: 'Reduzir a frequência das crises.',
        disponibilidade: 'Terça e sexta, qualquer horário.', telefone: '(51) 98333-4444',
        statusRelacionamento: 'separado', filhos: '1',
      },
    },
    { id: 'c6', nome: 'Carla T.', origem: 'WhatsApp', preferencia: 'F', modalidade: 'pacote', frequenciaSemanal: 1, duracaoMeses: 3, resumo: 'Em acompanhamento.', psicologaId: 'p1', agendamentoIso: null, pago: true },
    { id: 'c7', nome: 'Diego R.', origem: 'WhatsApp', preferencia: 'M', modalidade: 'avulso', resumo: 'Retorno.', psicologaId: 'p3', agendamentoIso: null, pago: true },
  ];
}
