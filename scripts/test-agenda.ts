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
  ['15/07/2026', '18:00', 'Mariana Silva', '5527999998888', 'Bruna Ferreira', 'Individual', 'Avulsa', 'Confirmada', '75', 'Pix', 'Não', '1ª sessão'],
  ['16/07/2026', '20:00', 'Ana e Rodrigo', '5527999996666', 'Bruna Ferreira', 'Casal', 'Avulsa', 'Cancelada', '150', 'Pix', 'Não', ''],
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
assert.strictEqual(agenda.length, 2);
assert.strictEqual(agenda[0].paciente, 'Mariana Silva');

const data: AgendaData = { psicologas: psic, grade, agenda };

const indiv = resumoDisponibilidade(data, { modalidade: 'Individual' });
assert.ok(indiv.includes('Bruna Ferreira'), 'individual: lista Bruna');
assert.ok(indiv.includes('Amanda Souza'), 'individual: lista Amanda');
assert.ok(indiv.includes('15/07/2026 18:00'), 'mostra ocupado confirmado');
assert.ok(!indiv.includes('Ana e Rodrigo'), 'não vaza nome de paciente ocupado');
assert.ok(!indiv.includes('20:00 Bruna'), 'agendamento CANCELADO não conta como ocupado');

const casal = resumoDisponibilidade(data, { modalidade: 'Casal' });
assert.ok(casal.includes('Bruna Ferreira'), 'casal: Bruna atende');
assert.ok(!casal.includes('Amanda Souza'), 'casal: Amanda NÃO atende casal');

console.log('OK test-agenda — parsers + resumo');
