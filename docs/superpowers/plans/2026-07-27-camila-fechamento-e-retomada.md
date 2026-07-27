# Leva 11 — Fechamento oficial + retomada sem repetir (plano de implementação)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) ou superpowers:executing-plans para implementar tarefa a tarefa. Os passos usam checkbox (`- [ ]`).

**Goal:** as quatro mensagens de encerramento da clínica passam a ser enviadas pelo código, palavra por palavra e uma por bolha; o paciente que retoma a conversa não recebe as informações de novo; e a chave Pix vira a do CNPJ da clínica.

**Architecture:** duas travas determinísticas novas, no mesmo padrão que resolveu o bug do nome (`contato.ts`) e o da condução (`conducao.ts`): módulos puros decidem o texto, o `computeReply` injeta o contexto e o **webhook** — depois de todos os backstops — escolhe as bolhas. O modelo perde a responsabilidade de redigir o fechamento e ganha um bloco dizendo o que já foi tratado.

**Tech Stack:** Next.js 16 (App Router), TypeScript, Postgres (`pg`), Google Gemini (`@google/genai`), scripts de teste com `npx tsx`.

**Spec:** `docs/superpowers/specs/2026-07-27-camila-fechamento-e-retomada-design.md`

**Revisado adversarialmente** (workflow multi-agente, 27/07): 19 achados confirmados foram incorporados. Os dois mais importantes: (a) montar as bolhas dentro do `computeReply` faria o fechamento sair **mesmo com o backstop de comprovante inválido**, porque o backstop roda depois; (b) detectar comprovante por regex de texto casaria também com os marcadores de comprovante RECUSADO.

---

### Task 1: Mensagens de fechamento e escolha das bolhas (módulo puro)

**Files:**
- Create: `src/lib/fechamento.ts`
- Test: `scripts/test-fechamento.ts`

- [ ] **Step 1: Escrever o teste que falha**

Criar `scripts/test-fechamento.ts`:

```ts
import assert from 'node:assert';
import {
  mensagensDeFechamento,
  bolhasDoTurno,
  FECHAMENTO_FORMULARIO,
  FECHAMENTO_CONFIRMACAO,
  FECHAMENTO_DUVIDA,
  FECHAMENTO_REMANEJAMENTO,
} from '../src/lib/fechamento';

const LINK = 'https://docs.google.com/forms/d/1A1DWxfinQWBU1oulWQRP7zsmKW6DHL6jjRXzzzX5bhg/viewform';
const bolhas = mensagensDeFechamento(LINK);

// 4 bolhas, na ordem que a Bruna definiu em 27/07/2026
assert.equal(bolhas.length, 4, 'sao 4 mensagens');
assert.equal(bolhas[0], `${FECHAMENTO_FORMULARIO} ${LINK}`);
assert.equal(bolhas[1], FECHAMENTO_CONFIRMACAO);
assert.equal(bolhas[2], FECHAMENTO_DUVIDA);
assert.equal(bolhas[3], FECHAMENTO_REMANEJAMENTO);

// texto exato da Bruna — qualquer edicao aqui e mudanca de PRODUTO, nao de codigo
assert.equal(
  FECHAMENTO_FORMULARIO,
  'Este é o nosso formulário, solicito que seja preenchido, pois é através dele que realizaremos o envio da sua triagem para a psicóloga:',
);
assert.equal(
  FECHAMENTO_CONFIRMACAO,
  'Confirmação realizada, após o preenchimento da triagem a psicóloga vai entrar em contato com você pelo WhatsApp.',
);
assert.equal(FECHAMENTO_DUVIDA, 'Caso tenha qualquer dúvida pode me chamar que eu te ajudo.');
assert.equal(
  FECHAMENTO_REMANEJAMENTO,
  'Caso você não se identifique com a profissional, podemos fazer o remanejamento para outra psicóloga, é só nos avisar.',
);

// nenhuma bolha e textao nem tem quebra dupla (cada item e UMA mensagem)
for (const b of bolhas) {
  assert.ok(b.length <= 350, `bolha curta: ${b.length} chars`);
  assert.ok(!b.includes('\n\n'), 'sem paragrafo duplo dentro da bolha');
  assert.equal(b, b.trim(), 'sem espaco sobrando');
}

// sem FORM_URL: primeira mensagem sai sem link e NUNCA com placeholder
const semLink = mensagensDeFechamento('');
assert.equal(semLink.length, 4);
assert.ok(!semLink[0].includes('{FORM_URL}'), 'nunca vaza placeholder');
assert.equal(semLink[0], FECHAMENTO_FORMULARIO);
assert.equal(mensagensDeFechamento('{FORM_URL}')[0], FECHAMENTO_FORMULARIO, 'placeholder cru nao vira link');

// bolhasDoTurno: e o unico ponto que decide fechamento vs resposta do modelo
assert.deepEqual(bolhasDoTurno({ enviarForm: true, resposta: 'qualquer coisa' }, LINK), bolhas);
const normal = bolhasDoTurno({ enviarForm: false, resposta: 'Oi!\n\nComo posso te chamar?' }, LINK);
assert.deepEqual(normal, ['Oi!', 'Como posso te chamar?'], 'sem handoff, reparte a resposta do modelo');

// handoff suprimido pelo backstop => NENHUM texto oficial sai
const suprimido = bolhasDoTurno({ enviarForm: false, resposta: 'O comprovante veio de outra chave, pode conferir?' }, LINK);
assert.ok(!suprimido.some((b) => b.includes(FECHAMENTO_FORMULARIO)), 'sem fechamento quando enviarForm=false');
assert.ok(!suprimido.some((b) => b.includes(LINK)), 'sem link quando enviarForm=false');

console.log('test-fechamento: todos os asserts passaram ✔');
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx tsx scripts/test-fechamento.ts`
Expected: FAIL — `Cannot find module '../src/lib/fechamento'`

- [ ] **Step 3: Implementar**

Criar `src/lib/fechamento.ts`:

```ts
// Mensagens oficiais de encerramento da Clínica Cazule — texto definido pela
// Bruna em 27/07/2026 (prints do WhatsApp). Ficam no CÓDIGO, não no prompt: o
// texto é da clínica e cada item precisa sair como UMA bolha curta (o modelo
// juntava tudo num parágrafo só). Funções puras.
import { splitReply } from './split-message';

/** Mensagem que entrega o formulário (o link é concatenado). */
export const FECHAMENTO_FORMULARIO =
  'Este é o nosso formulário, solicito que seja preenchido, pois é através dele que realizaremos o envio da sua triagem para a psicóloga:';

export const FECHAMENTO_CONFIRMACAO =
  'Confirmação realizada, após o preenchimento da triagem a psicóloga vai entrar em contato com você pelo WhatsApp.';

export const FECHAMENTO_DUVIDA = 'Caso tenha qualquer dúvida pode me chamar que eu te ajudo.';

export const FECHAMENTO_REMANEJAMENTO =
  'Caso você não se identifique com a profissional, podemos fazer o remanejamento para outra psicóloga, é só nos avisar.';

/**
 * As 4 bolhas do encerramento, na ordem definida pela Bruna. Uma mensagem de
 * WhatsApp por item — nada aqui passa pelo splitReply. Sem `formUrl` (ou com o
 * placeholder cru), a primeira sai sem link em vez de vazar `{FORM_URL}`.
 */
export function mensagensDeFechamento(formUrl: string): string[] {
  const link = (formUrl ?? '').trim();
  const valido = link.length > 0 && !link.includes('{');
  return [
    valido ? `${FECHAMENTO_FORMULARIO} ${link}` : FECHAMENTO_FORMULARIO,
    FECHAMENTO_CONFIRMACAO,
    FECHAMENTO_DUVIDA,
    FECHAMENTO_REMANEJAMENTO,
  ];
}

/**
 * ÚNICO ponto que decide o que o paciente recebe num turno: fechamento oficial
 * (handoff) ou a resposta do modelo repartida em bolhas. Chamado pelo webhook
 * DEPOIS dos backstops — se algum deles zerou `enviarForm`, nenhuma palavra do
 * fechamento sai. Os harnesses chamam a mesma função (fidelidade).
 */
export function bolhasDoTurno(turno: { enviarForm: boolean; resposta: string }, formUrl: string): string[] {
  return turno.enviarForm ? mensagensDeFechamento(formUrl) : splitReply(turno.resposta);
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx tsx scripts/test-fechamento.ts`
Expected: `test-fechamento: todos os asserts passaram ✔`

- [ ] **Step 5: Commit**

```bash
git add src/lib/fechamento.ts scripts/test-fechamento.ts
git commit -m "feat: mensagens oficiais de encerramento em 4 bolhas (texto da Bruna)"
```

---

### Task 2: Webhook entrega o fechamento (depois dos backstops)

**Files:**
- Modify: `src/app/api/whatsapp/webhook/route.ts:211-216`
- Modify: `src/lib/conversation.ts:178-184` (remove o append de link, que vira código morto)

- [ ] **Step 1: Trocar o envio no webhook**

Substituir:

```ts
      await sendTextSequence(from, splitReply(turno.resposta));
      try {
        await persistReply(from, nome, turno); // grava só depois de entregar
      } catch (err) {
        console.error('[webhook] erro ao persistir resposta', err);
      }
```

por:

```ts
      // A decisão do que sai fica AQUI, depois do backstop de comprovante: se ele
      // zerou enviarForm, nenhuma palavra do fechamento oficial é enviada.
      const bolhas = bolhasDoTurno(turno, process.env.FORM_URL ?? '');
      if (turno.enviarForm && !process.env.FORM_URL) {
        console.warn('[webhook] enviarForm=true sem FORM_URL — o fechamento vai sem o link.');
      }
      await sendTextSequence(from, bolhas);
      try {
        // grava o que o paciente REALMENTE recebeu (no handoff, o texto oficial)
        await persistReply(from, nome, { ...turno, resposta: bolhas.join('\n\n') });
      } catch (err) {
        console.error('[webhook] erro ao persistir resposta', err);
      }
```

- [ ] **Step 2: Ajustar os imports do webhook**

Trocar o import de `splitReply` por:

```ts
import { bolhasDoTurno } from '@/lib/fechamento';
```

(se `splitReply` não for mais usado nesse arquivo, remova o import — o `tsc` acusa)

- [ ] **Step 3: Remover o código morto do `computeReply`**

Em `src/lib/conversation.ts`, apagar o bloco que colava o link na resposta do modelo (agora o link vem do `fechamento.ts`):

```ts
  // Cinto e suspensórios: se a IA marcou enviarForm e o link não veio, adiciona.
  if (result.enviarForm && !resposta.includes(formUrl()) && process.env.FORM_URL) {
    resposta = `${resposta}\n\n${formUrl()}`;
  }
  if (result.enviarForm && !process.env.FORM_URL) {
    console.warn('[conversation] enviarForm=true mas FORM_URL não está setada — o paciente vai receber o placeholder.');
  }
```

- [ ] **Step 4: Compilar**

Run: `npx tsc --noEmit`
Expected: sem erros.

- [ ] **Step 5: Commit**

```bash
git add src/lib/conversation.ts src/app/api/whatsapp/webhook/route.ts
git commit -m "feat: webhook decide as bolhas apos os backstops (fechamento oficial)"
```

---

### Task 3: Bloco de retomada (módulo puro)

**Files:**
- Create: `src/lib/retomada.ts`
- Test: `scripts/test-retomada.ts`

Dois blocos diferentes, de propósito: **`[ONDE PARAMOS]`** quando o paciente sumiu por 6h+ (aí faz sentido "não reabra com boas-vindas, cumprimente e siga") e **`[JÁ TRATADO NESTA CONVERSA]`** quando é a mesma conversa em andamento (só a lista factual — mandar cumprimentar a cada turno brigaria com a regra de variação do prompt).

- [ ] **Step 1: Escrever o teste que falha**

Criar `scripts/test-retomada.ts`:

```ts
import assert from 'node:assert';
import { extrairSinais, proximaEtapa, blocoOndeParamos, type MensagemHistorico } from '../src/lib/retomada';
import { montarMarcadorComprovante, type AnaliseComprovante } from '../src/lib/comprovante-core';

const h = (role: 'user' | 'assistant', content: string, at?: Date): MensagemHistorico => ({ role, content, at });
const ONTEM = new Date('2026-07-26T20:00:00Z');
const HOJE = new Date('2026-07-27T09:00:00Z');

// primeiro contato: sem bloco
assert.equal(blocoOndeParamos([h('user', 'oi, boa tarde')]), '', 'primeiro contato nao ganha bloco');

// mesma conversa (gap curto): bloco factual, SEM instrucao de saudacao
const agora = new Date('2026-07-27T09:00:00Z');
const doisMin = new Date('2026-07-27T09:02:00Z');
const mesmaConversa: MensagemHistorico[] = [
  h('user', 'oi, quero terapia individual', agora),
  h('assistant', 'A avulsa é R$ 75,00 e o pacote mensal R$ 280,00.', agora),
  h('user', 'entendi', doisMin),
];
const bCurto = blocoOndeParamos(mesmaConversa);
assert.ok(/J[ÁA] TRATADO/.test(bCurto), 'gap curto usa o bloco factual');
assert.ok(!/Cumprimente/i.test(bCurto), 'gap curto NAO manda cumprimentar');
assert.ok(!/primeiro contato/i.test(bCurto), 'gap curto nao fala em reabertura');
assert.ok(/PEDIR de novo/i.test(bCurto), 'permite reenviar quando o paciente pede');
assert.ok(/HIST[ÓO]RICO vence/i.test(bCurto), 'o bloco se declara subordinado ao historico');

// retomada de verdade (dia seguinte): bloco completo
const retomada: MensagemHistorico[] = [
  h('user', 'oi, quero terapia individual', ONTEM),
  h('assistant', 'A avulsa é R$ 75,00 e o pacote mensal R$ 280,00.', ONTEM),
  h('user', 'bom dia, gostaria de agendar', HOJE),
];
const s1 = extrairSinais(retomada);
assert.equal(s1.valores, true, 'detecta valores informados');
assert.equal(s1.modalidade, 'individual', 'detecta modalidade dita pelo paciente');
assert.ok(s1.horasDesdeUltimoContato !== null && s1.horasDesdeUltimoContato > 12, 'calcula o intervalo');
const b1 = blocoOndeParamos(retomada);
assert.ok(/ONDE PARAMOS/.test(b1), 'monta o bloco de retomada');
assert.ok(/voltou/i.test(b1), 'menciona que a pessoa voltou depois');
assert.ok(/boas-vindas/i.test(b1), 'proibe reabrir com boas-vindas');
assert.ok(/Cumprimente/i.test(b1), 'manda cumprimentar em uma frase');

// modalidade: negacao e ambiguidade
assert.equal(extrairSinais([h('user', 'quero individual, não é de casal'), h('assistant', 'ok')]).modalidade, 'individual');
assert.equal(extrairSinais([h('user', 'é individual ou casal?'), h('assistant', 'ok')]).modalidade, null, 'pergunta nao decide');
assert.equal(extrairSinais([h('user', 'quero individual'), h('user', 'na verdade é casal')]).modalidade, 'casal', 'vale a ultima');

// opcao: PERGUNTAR sobre pacote nao e escolher
const perguntaPacote: MensagemHistorico[] = [
  h('user', 'quero individual'),
  h('assistant', 'A avulsa é R$ 75,00 e o pacote mensal R$ 280,00.'),
  h('user', 'tem pacote?'),
];
assert.equal(extrairSinais(perguntaPacote).opcaoEscolhida, false, '"tem pacote?" nao e escolha');
assert.ok(!/comprovante/i.test(proximaEtapa(extrairSinais(perguntaPacote))), 'nao pula pro comprovante');
assert.equal(
  extrairSinais([h('user', 'qual a diferença de avulsa pra pacote?')]).opcaoEscolhida,
  false,
  'comparacao de precos nao e escolha',
);
assert.equal(extrairSinais([h('user', 'prefiro a avulsa mesmo')]).opcaoEscolhida, true, 'decisao explicita conta');

// horario proposto: precisa ser OFERTA da Camila, nao horario de funcionamento
assert.equal(
  extrairSinais([h('assistant', 'A quinta às 18h está livre com a Larissa, quer que eu reserve?')]).horarioProposto,
  true,
);
assert.equal(extrairSinais([h('assistant', 'Consigo te encaixar quinta 13h45.')]).horarioProposto, true, 'formato 13h45');
assert.equal(extrairSinais([h('assistant', 'Posso reservar às 15h de quinta?')]).horarioProposto, true, 'hora antes do dia');
assert.equal(
  extrairSinais([h('assistant', 'Atendemos de segunda a sexta, das 8h às 20h.')]).horarioProposto,
  false,
  'horario de funcionamento nao e proposta',
);

// funil: so vai pro comprovante quando ha horario proposto E opcao escolhida
const semHorario = [h('user', 'quero individual'), h('assistant', 'Avulsa R$ 75,00.'), h('user', 'prefiro a avulsa')];
assert.ok(!/comprovante/i.test(proximaEtapa(extrairSinais(semHorario))), 'sem horario nao avanca pro pagamento');

// etapa do nome nao pode sumir
assert.ok(/primeiro nome/i.test(proximaEtapa(extrairSinais(retomada), { temNome: false })));
assert.ok(!/primeiro nome/i.test(proximaEtapa(extrairSinais(retomada), { temNome: true })));

// comprovante: usa a MESMA funcao da producao pra montar o marcador
const ANALISE: AnaliseComprovante = {
  ehComprovante: true,
  valor: 75,
  nomeDestinatario: 'Bruna Amorim',
  chaveDestino: '53480459000104',
  instituicao: 'Nubank',
  dataHora: '27/07/2026 10:00',
};
const ok = [h('user', 'quero individual'), h('user', montarMarcadorComprovante(ANALISE, 'confere'))];
assert.equal(extrairSinais(ok).comprovanteOk, true, 'comprovante valido detectado');
assert.equal(extrairSinais(ok).comprovanteRecusado, false);

const recusado = [
  h('user', 'quero individual'),
  h('user', montarMarcadorComprovante({ ...ANALISE, chaveDestino: '+55 11 91234-5678' }, 'nao_confere')),
];
const sRec = extrairSinais(recusado);
assert.equal(sRec.comprovanteRecusado, true, 'chave errada e comprovante RECUSADO');
assert.equal(sRec.comprovanteOk, false, 'recusado nunca conta como valido');
const etapaRec = proximaEtapa(sRec);
assert.ok(!/encerrar/i.test(etapaRec), 'NUNCA manda encerrar em cima de comprovante recusado');
assert.ok(/novo|correta|n[ãa]o foi aceito/i.test(etapaRec), 'manda pedir pagamento correto');

const naoComprovante = [h('user', montarMarcadorComprovante({ ...ANALISE, ehComprovante: false }, 'inconclusivo'))];
assert.equal(extrairSinais(naoComprovante).comprovanteOk, false, 'imagem qualquer nao vira comprovante');

console.log('test-retomada: todos os asserts passaram ✔');
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx tsx scripts/test-retomada.ts`
Expected: FAIL — `Cannot find module '../src/lib/retomada'`

- [ ] **Step 3: Implementar**

Criar `src/lib/retomada.ts`:

```ts
// Trava determinística contra "passou tudo de novo" quando o paciente retoma a
// conversa (pedido da Bruna em 27/07/2026, áudio + print). Mesma ideia do
// [DADOS DO CONTATO]: o código lê o histórico, deduz o que já foi tratado e diz
// ao modelo o que NÃO repetir. Funções puras.

export interface MensagemHistorico {
  role: 'user' | 'assistant';
  content: string;
  /** quando foi gravada — usado só pro intervalo da retomada */
  at?: Date | null;
}

export interface SinaisRetomada {
  valores: boolean;
  modalidade: 'individual' | 'casal' | null;
  horarioProposto: boolean;
  pixEnviado: boolean;
  opcaoEscolhida: boolean;
  /** comprovante ACEITO pela análise automática */
  comprovanteOk: boolean;
  /** comprovante recusado (chave/valor errado) ou imagem que não é comprovante */
  comprovanteRecusado: boolean;
  /** horas entre a última mensagem e a anterior (null quando não dá pra saber) */
  horasDesdeUltimoContato: number | null;
}

/** A partir daqui a conversa conta como RETOMADA (paciente sumiu e voltou). */
const RETOMADA_HORAS = 6;

const VALORES = /r\$\s?(75|150|280|550)\b/i;
const DIA = String.raw`(?:segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado)`;
// "18h", "18h30", "18 horas", "18:30" — o \b depois do h quebraria em "13h45"
const HORA = String.raw`\d{1,2}\s?(?:h(?:\s?\d{2}|oras?)?|:\s?\d{2})`;
const DIA_HORA = new RegExp(`(?:${DIA}[^.!?]{0,40}?${HORA}|${HORA}[^.!?]{0,25}?${DIA})`, 'i');
/** só conta como PROPOSTA se a Camila estiver oferecendo, não descrevendo o expediente */
const OFERTA = /livre|dispon[íi]vel|reserv|encaix|que tal|posso te (marcar|agendar)|consigo te|agendei|agendado|fica bom|te encaixo/i;
const PIX = /chave\s+pix|pix\s*\(/i;
/** escolha DECIDIDA (não "tem pacote?" nem "qual a diferença de avulsa pra pacote?") */
const OPCAO_DECIDIDA =
  /\b(quero|prefiro|vou (?:de|querer|ficar com)|fico com|escolho|pode ser|melhor)\b[^.!?]{0,30}\b(avulsa|pacote|quinzenal)\b|\b(avulsa|pacote|quinzenal)\b[^.!?]{0,20}\b(mesmo|ent[ãa]o|por favor)\b/i;
const COMPROVANTE_CABECA = /COMPROVANTE de pagamento detectado/i;
/** o marcador de recusa REPETE o cabeçalho, então a recusa tem que ser checada antes */
const COMPROVANTE_RECUSADO =
  /N[ÃA]O CONFERE|N[ÃA]O confirme o pagamento|N[ÃA]O parece ser um comprovante/i;

const algum = (h: MensagemHistorico[], role: 'user' | 'assistant', re: RegExp) =>
  h.some((m) => m.role === role && re.test(m.content));

/** Última modalidade que o PACIENTE afirmou; ignora pergunta e negação. */
function modalidadeDita(hist: MensagemHistorico[]): 'individual' | 'casal' | null {
  for (let i = hist.length - 1; i >= 0; i--) {
    const m = hist[i];
    if (m.role !== 'user') continue;
    const t = m.content;
    const negaCasal = /n[ãa]o (?:é|e|eh|seria|for)\b[^.!?]{0,15}casal/i.test(t);
    const temCasal = /\bcasal\b/i.test(t) && !negaCasal;
    const temIndividual = /\bindividual\b/i.test(t);
    if (temCasal && temIndividual && t.includes('?')) continue; // "individual ou casal?"
    if (temCasal && temIndividual) return 'individual'; // "individual, não de casal"
    if (temCasal) return 'casal';
    if (temIndividual) return 'individual';
  }
  return null;
}

export function extrairSinais(hist: MensagemHistorico[]): SinaisRetomada {
  const n = hist.length;
  const ultima = hist[n - 1]?.at;
  const anterior = hist[n - 2]?.at;
  const horas =
    ultima instanceof Date && anterior instanceof Date
      ? (ultima.getTime() - anterior.getTime()) / 3_600_000
      : null;
  const recusado = hist.some((m) => COMPROVANTE_RECUSADO.test(m.content));
  return {
    valores: algum(hist, 'assistant', VALORES),
    modalidade: modalidadeDita(hist),
    horarioProposto: hist.some(
      (m) => m.role === 'assistant' && DIA_HORA.test(m.content) && OFERTA.test(m.content),
    ),
    pixEnviado: algum(hist, 'assistant', PIX),
    opcaoEscolhida: algum(hist, 'user', OPCAO_DECIDIDA),
    comprovanteOk: !recusado && hist.some((m) => COMPROVANTE_CABECA.test(m.content)),
    comprovanteRecusado: recusado,
    horasDesdeUltimoContato: horas,
  };
}

export interface EtapaOpts {
  /** o [DADOS DO CONTATO] já resolveu o primeiro nome? */
  temNome?: boolean;
}

/**
 * Próxima etapa pendente, olhando o funil de trás pra frente. NUNCA manda
 * confirmar pagamento: quem decide isso é o marcador da análise do comprovante
 * (que pode ser de recusa) e o backstop do webhook.
 */
export function proximaEtapa(s: SinaisRetomada, opts: EtapaOpts = {}): string {
  if (s.comprovanteRecusado)
    return 'o último comprovante NÃO foi aceito — siga o que o marcador da análise manda: peça o pagamento para a chave correta da clínica, sem confirmar nada';
  if (s.comprovanteOk) return 'conferir o comprovante recebido e seguir exatamente o que o marcador da análise manda';
  if ((s.opcaoEscolhida || s.pixEnviado) && s.horarioProposto) return 'receber o comprovante do pagamento';
  if (s.horarioProposto) return 'confirmar o horário e perguntar se prefere avulsa ou pacote';
  if (s.valores && !opts.temNome) return 'perguntar como pode chamar a pessoa (só o primeiro nome)';
  if (s.valores) return 'entender o que a trouxe e a disponibilidade, e propor um horário concreto';
  if (s.modalidade) return 'passar os valores da modalidade';
  return 'seguir o funil normalmente';
}

/** Frase do intervalo (só é chamada quando já houve gap de 6h+). */
function trechoIntervalo(horas: number): string {
  if (horas < 24) return ' — a pessoa voltou algumas horas depois';
  const dias = Math.round(horas / 24);
  return ` — a pessoa voltou depois de ${dias} ${dias === 1 ? 'dia' : 'dias'}`;
}

function listaTratados(s: SinaisRetomada): string[] {
  const t: string[] = [];
  if (s.modalidade) t.push(`modalidade (${s.modalidade})`);
  if (s.valores) t.push('valores das sessões');
  if (s.horarioProposto) t.push('proposta de horário');
  if (s.pixEnviado) t.push('dados do Pix');
  if (s.opcaoEscolhida) t.push('escolha entre avulsa e pacote');
  if (s.comprovanteOk) t.push('comprovante enviado');
  if (s.comprovanteRecusado) t.push('comprovante enviado mas NÃO aceito');
  return t;
}

/**
 * Bloco pro system prompt. Vazio em primeiro contato. Com gap curto sai a versão
 * factual ([JÁ TRATADO]); com 6h+ sai a de retomada ([ONDE PARAMOS]), que é a
 * única que fala em saudação — mandar cumprimentar a cada turno brigaria com a
 * regra de variação do prompt.
 */
export function blocoOndeParamos(hist: MensagemHistorico[], opts: EtapaOpts = {}): string {
  if (hist.length < 2) return '';
  const s = extrairSinais(hist);
  const tratados = listaTratados(s);
  if (tratados.length === 0) return '';
  const etapa = proximaEtapa(s, opts);
  const rodape =
    'Este resumo é derivado automaticamente do histórico: se o histórico contradisser alguma linha daqui, o HISTÓRICO vence.';
  const horas = s.horasDesdeUltimoContato;

  if (horas == null || horas < RETOMADA_HORAS) {
    return `[JÁ TRATADO NESTA CONVERSA]
${tratados.join('; ')}.
Não repita isso por iniciativa própria — se a pessoa PEDIR de novo (valor, chave Pix, horário, link), aí sim reenvie normalmente.
Próxima etapa pendente: ${etapa}.
${rodape}`;
  }

  return `[ONDE PARAMOS]
Esta conversa NÃO é um primeiro contato${trechoIntervalo(horas)}. NUNCA reabra com boas-vindas ("Seja bem-vindo(a) à Cazule. Me chamo Camila...").
Já tratado: ${tratados.join('; ')}.
Não repita isso por iniciativa própria — se a pessoa PEDIR de novo, reenvie normalmente.
Próxima etapa pendente: ${etapa}. Cumprimente em UMA frase curta (pelo nome, se souber) e siga direto por ela.
${rodape}`;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx tsx scripts/test-retomada.ts`
Expected: `test-retomada: todos os asserts passaram ✔`

- [ ] **Step 5: Commit**

```bash
git add src/lib/retomada.ts scripts/test-retomada.ts
git commit -m "feat: bloco de retomada — sinais deterministicos do que ja foi tratado"
```

---

### Task 4: Injetar o bloco no contexto (histórico com data)

**Files:**
- Modify: `src/lib/conversation.ts` (`loadHistory`, `computeReply`)

- [ ] **Step 1: `loadHistory` passa a trazer `created_at`**

Substituir a função inteira:

```ts
async function loadHistory(waId: string): Promise<{ role: Role; content: string }[]> {
  const { rows } = await query<{ role: Role; content: string }>(
    `SELECT role, content FROM wa_messages
      WHERE wa_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
    [waId, HISTORY_LIMIT],
  );
  return rows.reverse(); // volta em ordem cronológica pra montar o prompt
}
```

por:

```ts
async function loadHistory(waId: string): Promise<MensagemHistorico[]> {
  const { rows } = await query<{ role: Role; content: string; created_at: Date }>(
    `SELECT role, content, created_at FROM wa_messages
      WHERE wa_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
    [waId, HISTORY_LIMIT],
  );
  // volta em ordem cronológica pra montar o prompt; `at` alimenta o bloco de retomada
  return rows.reverse().map((r) => ({ role: r.role, content: r.content, at: r.created_at }));
}
```

E adicionar o import junto dos outros:

```ts
import { blocoOndeParamos, type MensagemHistorico } from './retomada';
```

- [ ] **Step 2: Injetar o bloco e mandar só role/content pro Gemini**

Em `computeReply`, trocar:

```ts
  const contato = blocoContatoDe(await loadNomeFicha(waId), pushName);
  if (contato) system = `${system}\n\n${contato}`;
  const result = await runTriagemSemRepeticao({ system, messages: history });
```

por:

```ts
  const contato = blocoContatoDe(await loadNomeFicha(waId), pushName);
  if (contato) system = `${system}\n\n${contato}`;
  // Retomada: diz o que já foi tratado pra Camila não repassar tudo de novo
  // (pedido da Bruna, 27/07). Vazio em primeiro contato. `temNome` evita que o
  // bloco pule a etapa 3 do funil quando ainda não sabemos o nome.
  const ondeParamos = blocoOndeParamos(history, { temNome: Boolean(contato) });
  if (ondeParamos) system = `${system}\n\n${ondeParamos}`;
  const result = await runTriagemSemRepeticao({
    system,
    messages: history.map(({ role, content }) => ({ role, content })),
  });
```

- [ ] **Step 3: Compilar**

Run: `npx tsc --noEmit`
Expected: sem erros.

- [ ] **Step 4: Commit**

```bash
git add src/lib/conversation.ts
git commit -m "feat: computeReply injeta o bloco de retomada (historico com created_at)"
```

---

### Task 5: Prompt v18

**Files:**
- Modify: `src/lib/default-prompt.ts:35` (regra de retomada), `:144-148` (Passo 4), `:169` (versão)

- [ ] **Step 1: Passo 4 sem os textos**

Substituir as linhas do Passo 4:

```
- Confirme com essa mensagem exata: "Confirmação realizada! Vou te enviar agora um formulário de triagem pra você preencher — é por ele que a psicóloga recebe sua história antes da primeira conversa. Depois disso ela entra em contato por aqui pelo WhatsApp. Esse é o nosso canal de atendimento, então sempre que precisar pode nos chamar por aqui. Caso você não se identifique com a profissional, podemos fazer o remanejamento para outra psicóloga, é só nos avisar."
- E LOGO EM SEGUIDA, envie a mensagem do formulário: "Este é o nosso formulário, solicito que seja preenchido, pois é através dele que realizaremos o envio da sua triagem para a psicóloga: {FORM_URL}"
- Neste turno específico, MARQUE enviarForm = true na sua saída. É o gatilho pra você encerrar o atendimento automatizado — a partir daqui a psicóloga assume.
- REGRA DE OURO: NUNCA envie o formulário ANTES do comprovante. Sem comprovante = sem formulário.
```

por:

```
- MARQUE enviarForm = true na sua saída. É o gatilho do encerramento: o SISTEMA envia automaticamente as mensagens oficiais da clínica (o formulário de triagem com o link, a confirmação e o aviso de remanejamento), uma por vez, e a psicóloga assume a partir daí.
- NÃO escreva o texto do formulário, NÃO escreva o link e NÃO escreva a mensagem de confirmação: neste turno o que você redigir é descartado — basta marcar enviarForm = true.
- REGRA DE OURO: NUNCA marque enviarForm ANTES do comprovante. Sem comprovante = sem formulário. Se a análise do anexo disse que a chave NÃO confere, que não é comprovante, ou se o valor não bate, enviarForm continua false.
```

- [ ] **Step 2: Regra de retomada aponta pros blocos (sem virar "fonte da verdade")**

Trocar o começo da linha da "REGRA DE OURO da retomada":

```
- REGRA DE OURO da retomada: ANTES de responder, olhe o histórico.
```

por:

```
- REGRA DE OURO da retomada: ANTES de responder, olhe o histórico — e, quando houver um bloco [ONDE PARAMOS] ou [JÁ TRATADO NESTA CONVERSA] no contexto, use-o como resumo do que já foi dito e da próxima etapa (se ele contradisser o histórico, o histórico vence).
```

(o resto da linha continua igual)

- [ ] **Step 3: Bump da versão**

```ts
export const PROMPT_VERSION = '2026-07-27-cazule-v18-fechamento-oficial-e-retomada';
```

- [ ] **Step 4: Conferir que nada mais no prompt manda escrever os textos**

Run: `grep -n "Este é o nosso formulário\|Confirmação realizada\|{FORM_URL}" src/lib/default-prompt.ts`
Expected: nenhuma linha. (A menção na dúvida clássica "Quais os próximos passos?" — linha ~107 — **continua**: ali a Camila só EXPLICA que o formulário vem depois do pagamento, não escreve o texto oficial.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/default-prompt.ts
git commit -m "feat: prompt v18 — fechamento sai do prompt, retomada usa o bloco"
```

---

### Task 6: Chave Pix definitiva (envs + fixtures)

Feita ANTES dos testes com Gemini: se o `.env.local` tiver o CNPJ e as fixtures a chave de celular, o `sim-conversa` roda com o system dizendo uma chave e o marcador de comprovante dizendo outra — contradição que trava o funil.

**Files:**
- Modify: `.env.local` (local, não versionado) e envs do Railway
- Modify: `scripts/test-comprovante-core.ts`, `scripts/test-triagem.ts:35-42,64-68,233`, `scripts/sim-conversa.ts:34-48`

- [ ] **Step 1: Atualizar o `.env.local`**

```
PIX_INFO="Chave Pix (CNPJ): 53480459000104 — em nome de Cazule Psicologia"
PIX_CHAVE=53480459000104
```

- [ ] **Step 2: Asserts da chave nova no núcleo do comprovante**

Adicionar em `scripts/test-comprovante-core.ts` (antes do `console.log` final):

```ts
// chave definitiva da clínica (CNPJ) — comparação por sufixo de 8 dígitos
const PIX_CNPJ = 'Chave Pix (CNPJ): 53480459000104 — em nome de Cazule Psicologia';
assert.strictEqual(verificarDestinatario({ ...base, chaveDestino: '53480459000104' }, PIX_CNPJ), 'confere');
assert.strictEqual(verificarDestinatario({ ...base, chaveDestino: '53.480.459/0001-04' }, PIX_CNPJ), 'confere');
assert.strictEqual(verificarDestinatario({ ...base, chaveDestino: '53480459000104' }, '53480459000104'), 'confere');
assert.strictEqual(verificarDestinatario({ ...base, chaveDestino: '12.345.678/0001-99' }, PIX_CNPJ), 'nao_confere');
```

Run: `npx tsx scripts/test-comprovante-core.ts`
Expected: passa.

- [ ] **Step 3: Fixtures do `test-triagem.ts`**

`:39` → `chaveDestino: '53480459000104',`
`:37` → `nomeDestinatario: 'Cazule Psicologia',`
`:66-67` → `'Chave Pix (CNPJ): 53480459000104 — em nome de Cazule Psicologia',`
`:233` → `const temPix = /53480459000104|53\.480\.459/.test(todas);`

- [ ] **Step 4: Fixtures do `sim-conversa.ts`**

`:37-38` → `nomeDestinatario: 'Cazule Psicologia', chaveDestino: '53480459000104',`
`:47` → `process.env.PIX_INFO || 'Chave Pix (CNPJ): 53480459000104 — em nome de Cazule Psicologia',`

- [ ] **Step 5: Setar no Railway**

```bash
railway link -p 59c5392a-564d-4716-8c6a-7f7579b27a42 -e production -s clinica-psi-crm
railway variable set PIX_INFO="Chave Pix (CNPJ): 53480459000104 — em nome de Cazule Psicologia"
railway variable set PIX_CHAVE=53480459000104
```

(a CLI instalada é a 4.x — o subcomando é `variable`, não `variables`)

- [ ] **Step 6: Conferir o titular com a Bruna ANTES do deploy**

Mandar um Pix de R$ 0,01 pra chave `53480459000104` e ver que nome o app do banco mostra. Se for diferente de "Cazule Psicologia", reeditar só a `PIX_INFO` (sem deploy) — a validação usa a `PIX_CHAVE`, então o texto é cosmético, mas o paciente lê.

- [ ] **Step 7: Commit**

```bash
git add scripts/test-comprovante-core.ts scripts/test-triagem.ts scripts/sim-conversa.ts
git commit -m "test: fixtures com a chave Pix definitiva (CNPJ)"
```

---

### Task 7: Cenários novos no harness com Gemini

**Files:**
- Modify: `scripts/test-triagem.ts` (interface `Cenario`, `rodarCenario`, `main`, array `cenarios`)

- [ ] **Step 1: Campo `historico` na interface `Cenario`**

Em `scripts/test-triagem.ts:72-78`:

```ts
interface Cenario {
  nome: string;
  /** system alternativo (ex.: com bloco [DADOS DO CONTATO]); default = SYSTEM. */
  system?: string;
  /** histórico pré-existente (retomada): entra antes das falas e alimenta o bloco de retomada. */
  historico?: { role: 'user' | 'assistant'; content: string; at?: Date }[];
  falas: string[];
  checar: (t: Turno[]) => { ok: boolean; nota: string };
}
```

E o import, junto dos outros no topo:

```ts
import { blocoOndeParamos, type MensagemHistorico } from '../src/lib/retomada';
```

- [ ] **Step 2: `rodarCenario` semeia o histórico e injeta o bloco**

Em `scripts/test-triagem.ts:423`, trocar:

```ts
  const history: { role: 'user' | 'assistant'; content: string }[] = [];
```

por (duas linhas):

```ts
  const history: MensagemHistorico[] = [...(c.historico ?? [])];
  const systemBase = c.system ?? SYSTEM;
```

E em `scripts/test-triagem.ts:427`, trocar:

```ts
    const res = await runTriagemSemRepeticao({ system: c.system ?? SYSTEM, messages: history });
```

por:

```ts
    // espelha o computeReply: o bloco de retomada é remontado a cada turno
    const ondeParamos = blocoOndeParamos(history);
    const res = await runTriagemSemRepeticao({
      system: ondeParamos ? `${systemBase}\n\n${ondeParamos}` : systemBase,
      messages: history.map(({ role, content }) => ({ role, content })),
    });
```

Atenção: as linhas de `console.log` deste arquivo têm bytes ANSI de cor literais — não reescreva essas linhas, edite só as indicadas.

- [ ] **Step 3: Filtro por nome no `main`**

Em `scripts/test-triagem.ts:444-452`, trocar:

```ts
  let pass = 0;
  for (const c of cenarios) {
```

por:

```ts
  // filtro opcional por substring do nome: npx tsx ... test-triagem.ts retomada
  const filtro = (process.argv[2] ?? '').toLowerCase();
  const selecionados = filtro ? cenarios.filter((c) => c.nome.toLowerCase().includes(filtro)) : cenarios;
  let pass = 0;
  for (const c of selecionados) {
```

E trocar `cenarios.length` por `selecionados.length` nas duas linhas finais (mantendo os bytes ANSI que já estão lá).

- [ ] **Step 4: Adicionar os cenários**

Inserir no array `cenarios`, depois do cenário `'comprovante em imagem -> confirma e marca enviarForm'`:

```ts
  {
    nome: 'retomada no dia seguinte -> NAO repassa valores de novo',
    falas: ['bom dia, gostaria de agendar'],
    historico: [
      { role: 'user' as const, content: 'oi, quero terapia individual', at: new Date('2026-07-16T20:00:00Z') },
      {
        role: 'assistant' as const,
        content:
          'As sessões são online, por chamada de vídeo, com duração de 45 minutos 😊\n\nA avulsa é R$ 75,00 e o pacote mensal (4 sessões) sai por R$ 280,00. O pagamento é via Pix.\n\nComo posso te chamar?',
        at: new Date('2026-07-16T20:01:00Z'),
      },
      { role: 'user' as const, content: 'sou a Marina', at: new Date('2026-07-16T20:05:00Z') },
      { role: 'assistant' as const, content: 'Prazer, Marina! O que te trouxe à terapia agora?', at: new Date('2026-07-16T20:05:30Z') },
    ],
    checar: (t) => {
      const ultima = ultimo(t).resposta;
      const repassouValores = /r\$\s?(75|280)/i.test(ultima);
      const reabriu = /seja bem-?vind|me chamo camila/i.test(ultima);
      return {
        ok: !repassouValores && !reabriu,
        nota: `repassouValores=${repassouValores} reabriu=${reabriu} | ultima="${ultima.slice(0, 140)}"`,
      };
    },
  },
  {
    nome: 'paciente PEDE o valor de novo -> pode repetir',
    falas: ['qual era o valor mesmo?'],
    historico: [
      { role: 'user' as const, content: 'oi, quero terapia individual', at: new Date('2026-07-16T20:00:00Z') },
      {
        role: 'assistant' as const,
        content: 'A avulsa é R$ 75,00 e o pacote mensal (4 sessões) sai por R$ 280,00. O pagamento é via Pix.',
        at: new Date('2026-07-16T20:01:00Z'),
      },
      { role: 'user' as const, content: 'sou a Marina, ando ansiosa no trabalho', at: new Date('2026-07-16T20:03:00Z') },
      {
        role: 'assistant' as const,
        content: 'Imagino o quanto pesa, Marina. Quais dias funcionam melhor pra você?',
        at: new Date('2026-07-16T20:03:30Z'),
      },
    ],
    checar: (t) => {
      const ultima = ultimo(t).resposta;
      const reinformou = /r\$\s?(75|280)|\b(75|280)\b/i.test(ultima);
      return { ok: reinformou, nota: `reinformouValor=${reinformou} | ultima="${ultima.slice(0, 140)}"` };
    },
  },
```

- [ ] **Step 5: Rodar os cenários novos e os de comprovante inválido**

Run: `npx tsx --env-file=.env.local scripts/test-triagem.ts retomada`
Expected: `Resultado: 1/1`.

Run: `npx tsx --env-file=.env.local scripts/test-triagem.ts "valor de novo"`
Expected: `Resultado: 1/1`.

Run: `npx tsx --env-file=.env.local scripts/test-triagem.ts errada`
Expected: `Resultado: 2/2` — os cenários "comprovante com VALOR errado" e "comprovante com CHAVE errada" continuam sem `enviarForm`. **Este é o teste da correção do bloco de retomada**: se o bloco mandasse "confirmar o pagamento", eles quebrariam.

- [ ] **Step 6: Commit**

```bash
git add scripts/test-triagem.ts
git commit -m "test: cenarios de retomada (nao repassa valores) e de reenvio a pedido"
```

---

### Task 8: Fidelidade dos harnesses (sim e replay)

Os dois harnesses chamam `runTriagem` direto e imprimem `splitReply(res.resposta)` — mostrariam o texto do modelo no turno do handoff, que em produção passa a ser descartado. Sem isto, `sim` e `replay` validam algo que não existe (foi o tipo de achado da revisão da Leva 10).

**Files:**
- Modify: `scripts/sim-conversa.ts:214-218`
- Modify: `scripts/replay-conversas.ts:89-109`

- [ ] **Step 1: `sim-conversa.ts` — imports**

```ts
import { bolhasDoTurno } from '../src/lib/fechamento';
import { blocoOndeParamos, type MensagemHistorico } from '../src/lib/retomada';
```

- [ ] **Step 2: `sim-conversa.ts` — bloco por turno e bolhas pela função de produção**

Trocar a declaração do histórico (`:199`):

```ts
  const history: { role: 'user' | 'assistant'; content: string }[] = [];
```

por:

```ts
  const history: MensagemHistorico[] = [];
```

E substituir as linhas 214-218:

```ts
    const res = await runTriagemSemRepeticao({ system, messages: history });
    ultimo = res;
    history.push({ role: 'assistant', content: res.resposta });
    const bolhas = splitReply(res.resposta);
    transcript.push({ paciente: fala, camila: res.resposta, enviarForm: res.enviarForm });
```

por:

```ts
    const ondeParamos = blocoOndeParamos(history, { temNome: Boolean(persona.comNome) });
    const res = await runTriagemSemRepeticao({
      system: ondeParamos ? `${system}\n\n${ondeParamos}` : system,
      messages: history.map(({ role, content }) => ({ role, content })),
    });
    ultimo = res;
    // MESMA função da produção: no handoff quem escreve é o código.
    const bolhas = bolhasDoTurno(res, process.env.FORM_URL ?? '');
    const enviado = bolhas.join('\n\n');
    history.push({ role: 'assistant', content: enviado });
    transcript.push({ paciente: fala, camila: enviado, enviarForm: res.enviarForm });
```

(o `history.push` do lado do paciente, logo acima, continua igual)

- [ ] **Step 3: `replay-conversas.ts` — imports**

```ts
import { bolhasDoTurno } from '../src/lib/fechamento';
import { blocoOndeParamos, type MensagemHistorico } from '../src/lib/retomada';
```

- [ ] **Step 4: `replay-conversas.ts` — histórico com data real**

O log do Postgres tem `created_at` por mensagem: usar isso faz o replay medir o intervalo de verdade — é o caso exato que a Bruna perguntou. Trocar a linha 89:

```ts
    const history: { role: 'user' | 'assistant'; content: string }[] = [];
```

por:

```ts
    const history: MensagemHistorico[] = [];
```

E os três `history.push` do loop (linhas 98, 108, 109):

```ts
          history.push({ role: 'user', content: m.content, at: m.created_at });
```
```ts
            history.push({ role: 'user', content: m.content, at: m.created_at });
            history.push({
              role: 'assistant',
              content: antiga.startsWith('(') ? res.resposta : antiga,
              at: msgs[i + 1]?.created_at ?? m.created_at,
            });
```

- [ ] **Step 5: `replay-conversas.ts` — bloco por turno e bolhas pela função de produção**

Trocar as linhas 100-101:

```ts
            const res = await runTriagemSemRepeticao({ system: systemConv, messages: history });
            const bolhas = splitReply(res.resposta);
```

por:

```ts
            const ondeParamos = blocoOndeParamos(history, { temNome: Boolean(nomePorConversa.get(waId)) });
            const res = await runTriagemSemRepeticao({
              system: ondeParamos ? `${systemConv}\n\n${ondeParamos}` : systemConv,
              messages: history.map(({ role, content }) => ({ role, content })),
            });
            const bolhas = bolhasDoTurno(res, process.env.FORM_URL ?? '');
```

- [ ] **Step 6: Compilar**

Run: `npx tsc --noEmit`
Expected: sem erros. Se `splitReply` ficou sem uso em algum dos dois scripts, remova o import.

- [ ] **Step 7: Commit**

```bash
git add scripts/sim-conversa.ts scripts/replay-conversas.ts
git commit -m "test: harnesses usam bolhasDoTurno e o bloco de retomada"
```

---

### Task 9: Suíte completa + build

- [ ] **Step 1: Testes puros**

Run:
```bash
npx tsx scripts/test-fechamento.ts && npx tsx scripts/test-retomada.ts && npx tsx scripts/test-contato.ts && npx tsx scripts/test-conducao.ts && npx tsx scripts/test-anti-repeat.ts && npx tsx scripts/test-parse-modelo.ts && npx tsx scripts/test-split.ts && npx tsx scripts/test-comprovante-core.ts && npx tsx scripts/test-agenda.ts && npx tsx scripts/test-followup.ts
```
Expected: exit 0 no encadeamento inteiro — 7 linhas `…todos os asserts passaram ✔` e 3 linhas no formato `OK test-…` (`test-split`, `test-agenda` e `test-followup` usam esse outro formato).

- [ ] **Step 2: Harness com Gemini**

Run: `npx tsx --env-file=.env.local scripts/test-triagem.ts`
Expected: ≥ 22 de 25. Os cenários de comprovante inválido ("VALOR errado", "CHAVE errada") **têm** que passar — são a regressão que o bloco de retomada poderia causar.

- [ ] **Step 3: Simulações**

Run: `npx tsx --env-file=.env.local scripts/sim-conversa.ts passivo`
Expected: funil fecha; no fim aparecem as 4 mensagens de fechamento, na ordem, cada uma como bolha própria.

Run: `npx tsx --env-file=.env.local scripts/sim-conversa.ts recorrente`
Expected: a persona de paciente conhecido não recebe os valores de novo nem boas-vindas.

- [ ] **Step 4: Replay com histórico real**

Run (PowerShell, com a URL pública do Postgres no ambiente):
```powershell
$env:DATABASE_PUBLIC_URL = (railway variable list -s Postgres --json | ConvertFrom-Json).DATABASE_PUBLIC_URL
npx tsx --env-file=.env.local scripts/replay-conversas.ts
```
Expected: nenhuma resposta reabrindo com "Seja bem-vindo(a) à Cazule" em conversa que já tinha histórico. Guardar a saída — é a evidência que responde à pergunta da Bruna.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: build passa.

- [ ] **Step 6: Commit (se algum ajuste foi necessário)**

```bash
git add -u
git commit -m "test: suite verde com fechamento oficial e retomada"
```

---

### Task 10: Deploy

- [ ] **Step 1: Confirmar que o prompt do código é o que vale**

Run (SQL na base de produção):
```sql
SELECT key, left(value, 60) FROM app_config;
```
Expected: nenhuma linha com `system_prompt`. Se houver, `DELETE FROM app_config WHERE key='system_prompt';` (armadilha #1 do `CONTEXTO-CAZULE.md`).

- [ ] **Step 2: Push**

```bash
gh auth switch --user vertechsolutions && gh auth setup-git && git push origin master
```

- [ ] **Step 3: Verificar o deploy**

Run: `curl -s https://clinica-psi-crm-production.up.railway.app/api/health`
Expected: 200.

- [ ] **Step 4: Teste real no WhatsApp**

Pelo número de teste: (a) ir até o comprovante e conferir as 4 bolhas separadas, na ordem, com o link na primeira; (b) mandar um comprovante de outra chave e conferir que **nenhuma** das 4 sai; (c) voltar no dia seguinte com "oi, gostaria de agendar" e conferir que ela não repassa valores.

---

### Task 11: Documentação e mensagem pra Bruna

**Files:**
- Modify: `CONTEXTO-CAZULE.md` (nova seção "Leva 11")
- Create: `mensagem-bruna-v18.md`

- [ ] **Step 1: Seção da Leva 11 no CONTEXTO-CAZULE.md**

Registrar: os dois pedidos do áudio de 27/07, os quatro textos oficiais, o fechamento determinístico (e por que a decisão das bolhas mora no webhook, depois dos backstops), os dois blocos de retomada, a troca da chave Pix e o resultado dos testes.

- [ ] **Step 2: Mensagem pra Bruna**

Criar `mensagem-bruna-v18.md` no estilo das anteriores (formatação WhatsApp, sem textão): o que mudou no fechamento (com as 4 mensagens dela), a resposta sobre retomada (com a evidência do replay) e o aviso de que a chave Pix agora é a do CNPJ.

- [ ] **Step 3: Commit**

```bash
git add CONTEXTO-CAZULE.md mensagem-bruna-v18.md docs/superpowers
git commit -m "docs: Leva 11 — fechamento oficial (v18) + retomada"
```

---

## Fora de escopo (backlog)

- **Agenda quebrada (Sheets 400)** — Leva 9, spec e plano próprios. É o que faz a Camila inventar psicóloga.
- **Flag `comprovante_ok` persistido** em `wa_conversations`: hoje o backstop do webhook só enxerga o anexo do turno atual. Se o paciente manda comprovante inválido e no turno seguinte escreve texto, o backstop está desligado — o bloco de retomada agora cobre esse caso pelo prompt, mas uma trava de código seria mais forte.
- **Conversa pausada**: se o paciente responder depois do handoff, a Camila fica muda e só um log registra. Vale um alerta pra Bruna no WhatsApp.
- LGPD (cripto em repouso do `lead`), opt-out do follow-up, triagem no Drive da psicóloga.
