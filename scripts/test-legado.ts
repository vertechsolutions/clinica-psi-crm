/**
 * Testes do núcleo da lista de legado — as conversas que já eram atendidas à mão
 * pela Bruna quando a Camila entrou no WhatsApp profissional dela.
 *
 * Tudo puro: sem rede, sem banco, sem API key.
 *
 * Rodar:  npx tsx scripts/test-legado.ts
 */
import assert from 'node:assert';
import {
  chavesEquivalentes,
  ehProtegido,
  hashChave,
  hashesDe,
  hashLid,
  identificadoresParaLegado,
  impressaoDigital,
  protegidos,
} from '../src/lib/legado-core';
import { ehConversaIndividual, normalizarWaId } from '../src/lib/wa/types';

const CHAVE = 'chave-de-teste-bem-comprida';

// ── variantes do 9º dígito ────────────────────────────────────────────────────
// No aparelho da Bruna, 64 dos 720 chats vêm com 12 dígitos. Se a lista guardasse
// só a forma que o /chats devolveu, a mensagem do MESMO humano chegando na outra
// forma não casaria — e a Camila responderia uma paciente em atendimento.
{
  const comNove = chavesEquivalentes('5549999551051'); // 55 + 49 + 9 9955-1051
  assert.deepStrictEqual(comNove.sort(), ['554999551051', '5549999551051'].sort(),
    'celular de 13 dígitos gera também a forma sem o 9');

  const semNove = chavesEquivalentes('554988887777'); // 55 + 49 + 8888-7777
  assert.deepStrictEqual(semNove.sort(), ['5549988887777', '554988887777'].sort(),
    'celular de 12 dígitos gera também a forma com o 9');

  // fixo (local começa em 3) não vira celular
  assert.deepStrictEqual(chavesEquivalentes('554933334444'), ['554933334444'],
    'fixo não ganha 9º dígito');

  // número de fora do Brasil fica como está
  assert.deepStrictEqual(chavesEquivalentes('351912345678'), ['351912345678'],
    'número estrangeiro não é remexido');

  assert.deepStrictEqual(chavesEquivalentes('+55 (49) 99955-1051').sort(), comNove.sort(),
    'entrada suja normaliza igual');
  assert.deepStrictEqual(chavesEquivalentes(''), [], 'vazio não gera chave');
}

// ── hash ──────────────────────────────────────────────────────────────────────
{
  const a = hashChave('5549999551051', CHAVE);
  assert.strictEqual(a, hashChave('+55 (49) 99955-1051', CHAVE), 'hash é determinístico e normaliza');
  assert.notStrictEqual(a, hashChave('5549999551051', 'outra-chave'),
    'trocar a chave muda o hash — é o que a impressão digital detecta');
  assert.ok(!a.includes('5549'), 'o hash não carrega o número');
  assert.strictEqual(a.length, 64, 'sha256 em hex');

  assert.strictEqual(hashesDe('554988887777', CHAVE).length, 2, 'grava as duas grafias');
  assert.deepStrictEqual(
    hashesDe('554988887777', CHAVE).sort(),
    hashesDe('5549988887777', CHAVE).sort(),
    'as duas grafias produzem o MESMO par de hashes — é isso que faz o gate casar',
  );

  const fp = impressaoDigital(CHAVE);
  assert.strictEqual(fp, impressaoDigital(CHAVE));
  assert.notStrictEqual(fp, impressaoDigital('outra'));
  assert.ok(!CHAVE.includes(fp) && fp.length === 16, 'a impressão digital não revela a chave');
}

// ── equipe protegida ──────────────────────────────────────────────────────────
// Sem isto o snapshot marcaria a Bruna e o Murilo (que obviamente já conversam
// com esse celular) e a Camila ficaria muda justo pra quem precisa testá-la.
{
  const env = {
    NOTIFY_ALERT_NUMBERS: '5527981178233,5549999551051',
    WA_ALLOWLIST: '5511988887777',
  } as unknown as NodeJS.ProcessEnv;

  assert.deepStrictEqual(protegidos(env).sort(), ['5527981178233', '5549999551051'].sort(),
    'a equipe sai de NOTIFY_ALERT_NUMBERS');
  assert.ok(!protegidos(env).includes('5511988887777'),
    'WA_ALLOWLIST NÃO entra: senão o conjunto protegido encolheria no dia da virada');
  assert.ok(ehProtegido('5549999551051', env));
  assert.ok(ehProtegido('554999551051', env), 'protege também a outra grafia do mesmo número');
  assert.ok(!ehProtegido('5511999998888', env));
  assert.ok(!ehProtegido('5549999551051', {} as NodeJS.ProcessEnv), 'sem env, ninguém é protegido');
}

// ── contato com número oculto (lid) ───────────────────────────────────────────
// Mais da METADE das conversas antigas da Bruna chega sem `phone`, só com `lid`.
// Ignorá-las deixaria metade dos pacientes antigos desprotegidos.
{
  const a = hashLid('999999999999999', CHAVE);
  assert.strictEqual(a, hashLid('999999999999999@lid', CHAVE), 'normaliza o sufixo @lid');
  assert.notStrictEqual(a, hashChave('999999999999999', CHAVE),
    'lid e telefone vivem em namespaces separados — um lid que coincida com um telefone não pode calar a pessoa errada');
  assert.notStrictEqual(a, hashLid('999999999999999', 'outra'));
}

// ── o que vira linha na lista ─────────────────────────────────────────────────
{
  const env = { NOTIFY_ALERT_NUMBERS: '5549999551051' } as unknown as NodeJS.ProcessEnv;
  const r = identificadoresParaLegado(
    [
      { phone: '5527999990001', isGroup: false },
      { phone: '5527999990001', isGroup: false }, // repetido
      { phone: '120363019502650977', isGroup: true }, // grupo
      { phone: '', lid: '888888888888888', isGroup: false }, // número oculto: entra pelo lid
      { phone: '5527999990003', lid: '777777777777777', isGroup: false }, // tem os dois
      { phone: '', isGroup: false }, // sem nada aproveitável
      { phone: '123', isGroup: false }, // curto demais
      { phone: '5549999551051', isGroup: false }, // equipe
    ],
    env,
  );
  assert.deepStrictEqual(r.telefones.sort(), ['5527999990001', '5527999990003'].sort());
  assert.deepStrictEqual(r.lids.sort(), ['777777777777777', '888888888888888'].sort(),
    'guarda o lid mesmo quando há telefone — a pessoa pode chegar de um jeito no import e de outro no webhook');
  assert.strictEqual(r.somenteLid, 1, 'só o que não tinha telefone conta como "só lid"');
  assert.strictEqual(r.grupos, 1);
  assert.strictEqual(r.invalidos, 2);
  assert.strictEqual(r.protegidos, 1);
}

// ── o objeto que chega no core não pode carregar nome/anotação ────────────────
// Assert sobre as chaves INTEIRAS: um `...resto` num spread do provider passaria
// despercebido num teste que só checasse a ausência de `name`.
{
  const r = identificadoresParaLegado(
    [{ phone: '5527999990002', isGroup: false }],
    {} as NodeJS.ProcessEnv,
  );
  assert.deepStrictEqual(
    Object.keys(r).sort(),
    ['grupos', 'invalidos', 'lids', 'protegidos', 'somenteLid', 'telefones'].sort(),
    'o resultado é só contagem + identificadores — nada de nome, anotação ou data',
  );
  assert.deepStrictEqual(r.telefones, ['5527999990002']);
}

// ── identificador que não é pessoa ────────────────────────────────────────────
// Enquanto a WA_ALLOWLIST está preenchida isto fica escondido; esvaziá-la abriria
// caminho pra status@broadcast virar uma "conversa" de wa_id vazio.
{
  assert.strictEqual(normalizarWaId('status@broadcast'), '', 'o normalizador some com tudo aqui');
  assert.ok(!ehConversaIndividual('status@broadcast'));
  assert.ok(!ehConversaIndividual('120363019502650977-group'));
  assert.ok(!ehConversaIndividual('120363019502650977@g.us'));
  assert.ok(!ehConversaIndividual('123456789@newsletter'));
  assert.ok(!ehConversaIndividual('5527999990001', true), 'isNewsletter derruba mesmo com telefone');
  assert.ok(!ehConversaIndividual(''));
  assert.ok(!ehConversaIndividual(undefined));
  assert.ok(!ehConversaIndividual('123456789'), '9 dígitos não é telefone de gente');
  assert.ok(!ehConversaIndividual('1234567890123456'), '16 dígitos também não');
  assert.ok(ehConversaIndividual('5527988420050'));
  assert.ok(ehConversaIndividual('+55 (27) 98842-0050'));
  // o @lid PASSA no parse de propósito: quem decide é o webhook, que não atende e
  // avisa a equipe. Barrar aqui faria a mensagem sumir sem ninguém saber.
  assert.ok(ehConversaIndividual('999999999999999@lid'));
}

console.log('✓ test-legado: OK');
