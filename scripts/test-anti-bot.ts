/**
 * Testes da detecção de bot (puro, sem rede, sem banco).
 * Rodar:  npx tsx scripts/test-anti-bot.ts
 *
 * Terceira pedida da Bruna (06/08/2026). O risco desta feature NÃO é deixar um
 * bot passar — é calar um paciente de verdade: a ação é pausar a conversa, e uma
 * conversa pausada só volta pela mão da equipe. Por isso a maioria dos asserts
 * aqui é NEGATIVA: prova que gente normal não dispara o alarme.
 */
import assert from 'node:assert';
import { agruparPorTurno, pareceBot, ultimosTurnosDoLead } from '../src/lib/anti-bot';
import { montarMarcadorComprovante } from '../src/lib/comprovante-core';

const u = (content: string) => ({ role: 'user' as const, content });
const a = (content: string) => ({ role: 'assistant' as const, content });

/** frase longa o bastante pra passar do MIN_CARACTERES — o que um bot manda */
const BOT = 'olá, gostaria de saber mais sobre os planos de atendimento';

// ── agruparPorTurno: a base de tudo ──────────────────────────────────────────
assert.deepEqual(
  agruparPorTurno([u('a'), u('b'), a('c'), u('d')]).map((t) => t.partes),
  [2, 1, 1],
  'mensagens consecutivas do mesmo papel viram UM turno',
);
assert.deepEqual(
  agruparPorTurno([u('a'), u('b')]).map((t) => t.texto),
  ['a\nb'],
  'o texto das partes é concatenado',
);
assert.deepEqual(agruparPorTurno([]), [], 'histórico vazio');

// ── o caso alvo ──────────────────────────────────────────────────────────────
assert.equal(
  pareceBot([u(BOT), a('claro, posso te ajudar'), u(BOT), a('como eu disse'), u(BOT)]),
  true,
  'três turnos idênticos do lead, com resposta entre eles',
);

// ── falsos positivos: o que esta feature NÃO pode fazer ─────────────────────
// O lead ansioso mandando a mesma coisa três vezes numa rajada. O debounce junta
// numa resposta só; se o anti-bot contasse linha em vez de turno, ele calaria
// essa pessoa na PRIMEIRA interação da conversa.
assert.equal(pareceBot([u(BOT), u(BOT), u(BOT)]), false, 'rajada debounced é UM turno');

// A mesma foto reenviada em três turnos gera três marcadores idênticos. Sem a
// guarda, pausaria um paciente que acabou de pagar.
const MARCA = montarMarcadorComprovante(null, 'inconclusivo');
assert.equal(
  pareceBot([u(MARCA), a('recebi!'), u(MARCA), a('recebi!'), u(MARCA)]),
  false,
  'marcador de anexo é texto NOSSO — nunca julga o lead por ele',
);
assert.equal(
  pareceBot([u('[áudio transcrito]: oi tudo bem'), a('x'), u('[áudio transcrito]: oi tudo bem'), a('y'), u('[áudio transcrito]: oi tudo bem')]),
  false,
  'transcrição de áudio também é marcador do sistema',
);

// Confirmação curta repetida é gente.
assert.equal(pareceBot([u('ok'), a('x'), u('ok'), a('y'), u('ok')]), false, '"ok" três vezes é gente');
assert.equal(pareceBot([u('oi'), a('x'), u('oi'), a('y'), u('oi')]), false, '"oi" três vezes é gente');

// O limiar é TRÊS, não dois.
assert.equal(pareceBot([u(BOT), a('x'), u(BOT)]), false, 'dois turnos idênticos não bastam');

// Histórico curto.
assert.equal(pareceBot([]), false, 'histórico vazio');
assert.equal(pareceBot([u(BOT)]), false, 'um turno só');

// Repetição da ASSISTENTE não é bot do lead (isso é problema do anti-repeat).
assert.equal(
  pareceBot([u('a mensagem numero um'), a(BOT), u('a mensagem numero dois'), a(BOT), u('a mensagem numero tres'), a(BOT)]),
  false,
  'quem repete é a Camila, não o lead',
);

// Conversa normal, textos diferentes.
assert.equal(
  pareceBot([
    u('oi, queria saber o valor da sessao'),
    a('claro'),
    u('e vocês atendem online mesmo?'),
    a('sim'),
    u('perfeito, quero agendar entao'),
  ]),
  false,
  'conversa de verdade não dispara',
);

// ── normalização: maiúscula, acento e pontuação não salvam o bot ────────────
// `normalizaComparacao` do anti-repeat NÃO remove acento — daí a normalização
// própria. Sem ela, "atendiménto" escaparia.
assert.equal(
  pareceBot([
    u(BOT),
    a('x'),
    u('OLÁ, GOSTARIA DE SABER MAIS SOBRE OS PLANOS DE ATENDIMENTO!!!'),
    a('y'),
    u('Ola gostaria de saber mais sobre os planos de atendimento.'),
  ]),
  true,
  'caixa, acento e pontuação não disfarçam o bot',
);

// ── só os últimos n contam ──────────────────────────────────────────────────
assert.equal(
  pareceBot([u('primeiro contato, outra coisa'), a('x'), u(BOT), a('x'), u(BOT), a('x'), u(BOT)]),
  true,
  'o começo da conversa não impede a detecção',
);
assert.equal(
  pareceBot([u(BOT), a('x'), u(BOT), a('x'), u(BOT), a('x'), u('agora mudei de assunto completamente')]),
  false,
  'o lead voltou a falar coisa nova — não é mais bot',
);

// ── limiar configurável ─────────────────────────────────────────────────────
assert.equal(pareceBot([u(BOT), a('x'), u(BOT)], 2), true, 'com n=2, dois turnos bastam');

// ── o que o alerta mostra pra equipe ────────────────────────────────────────
assert.deepEqual(
  ultimosTurnosDoLead([u('um'), a('x'), u('dois'), a('y'), u('tres'), u('tres e meio')]),
  ['um', 'dois', 'tres\ntres e meio'],
  'o alerta leva os três últimos turnos do lead, com a rajada junta',
);

console.log('test-anti-bot: todos os asserts passaram ✔');
