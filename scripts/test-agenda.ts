import assert from 'node:assert';
import {
  parsePsicologas,
  parseGrade,
  parseAgenda,
  resumoDisponibilidade,
  type AgendaData,
} from '../src/lib/agenda-core';

const psicRows = [
  ['Psicóloga', 'CRP', 'Abordagens', 'Atende Individual', 'Atende Casal', 'Atende Infanto-juvenil (13+)', 'Preferência do paciente (F/M)', 'Observações'],
  ['Bruna Ferreira', 'CRP 16/1', 'TCC, Humanista', 'Sim', 'Sim', 'Sim', 'F', 'Coordenação'],
  ['Amanda Souza', 'CRP 16/2', 'Psicanálise', 'Sim', 'Não', 'Não', 'F', ''],
];
const gradeRows = [
  ['Psicóloga', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'],
  ['Bruna Ferreira', '14:00-19:00', '14:00-19:00', '-', '14:00-19:00', '14:00-18:00', '-'],
  ['Amanda Souza', '-', '08:00-12:00', '08:00-12:00', '08:00-12:00', '-', '08:00-11:00'],
];
const agendaRows = [
  ['Data', 'Hora', 'Paciente', 'WhatsApp', 'Psicóloga', 'Modalidade', 'Tipo', 'Status', 'Valor (R$)', 'Pagamento', 'Nota Fiscal?', 'Observações'],
  ['10/07/2026', '09:00', 'Antiga Paciente', '5527999997777', 'Amanda Souza', 'Individual', 'Avulsa', 'Realizada', '75', 'Pix', 'Não', 'passada'],
  ['18/07/2026', '18:00', 'Mariana Silva', '5527999998888', 'Bruna Ferreira', 'Individual', 'Avulsa', 'Confirmada', '75', 'Pix', 'Não', '1ª sessão'],
  ['20/07/2026', '20:00', 'Ana e Rodrigo', '5527999996666', 'Bruna Ferreira', 'Casal', 'Avulsa', 'Cancelado', '150', 'Pix', 'Não', ''],
];

const psic = parsePsicologas(psicRows);
assert.strictEqual(psic.length, 2);
assert.strictEqual(psic[0].nome, 'Bruna Ferreira');
assert.strictEqual(psic[0].casal, true);
assert.strictEqual(psic[1].casal, false);

const grade = parseGrade(gradeRows);
assert.strictEqual(grade[0].janelas['Segunda'], '14:00-19:00');
assert.strictEqual(grade[0].janelas['Quarta'], undefined); // '-' vira ausência

const agenda = parseAgenda(agendaRows);
assert.strictEqual(agenda.length, 3);
assert.strictEqual(agenda[1].paciente, 'Mariana Silva');

const data: AgendaData = { psicologas: psic, grade, agenda };

// hoje fixo (16/07): 10/07 é passada, 18/07 é futura, 20/07 é cancelada
const resumo = resumoDisponibilidade(data, { hoje: new Date(2026, 6, 16) });

// informa a data de referência pro modelo (16/07/2026 é quinta-feira)
assert.ok(resumo.includes('Hoje é quinta-feira, 16/07/2026.'), 'linha de data de hoje');

// todas as psicólogas com janela aparecem, com as tags do que atendem
assert.ok(resumo.includes('Bruna Ferreira'), 'lista Bruna');
assert.ok(resumo.includes('Amanda Souza'), 'lista Amanda');
assert.ok(/Bruna Ferreira \(.*atende: individual, casal, infanto 13\+\)/.test(resumo), 'tags da Bruna (ind+casal+infanto)');
assert.ok(/Amanda Souza \(.*atende: individual\)/.test(resumo), 'tags da Amanda (só individual)');

// reservas: futura aparece; passada e cancelada não; nome de paciente nunca vaza
assert.ok(resumo.includes('18/07/2026 18:00'), 'mostra reserva futura confirmada');
assert.ok(!resumo.includes('10/07/2026'), 'reserva PASSADA não aparece');
assert.ok(!resumo.includes('20/07/2026'), 'reserva CANCELADA não aparece');
assert.ok(!resumo.includes('Mariana Silva'), 'não vaza nome de paciente');
assert.ok(!resumo.includes('Ana e Rodrigo'), 'não vaza nome de paciente cancelado');
assert.ok(!resumo.includes('5527999998888'), 'não vaza telefone de paciente');

console.log('OK test-agenda — parsers + resumo v2 (tags + filtro de datas)');
