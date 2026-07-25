# Camila v17 — nome já conhecido + condução que nunca para (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Ao iniciar a execução, copie este plano para `docs/superpowers/plans/2026-07-25-camila-nome-e-conducao.md`** (é lá que as levas ficam versionadas; o arquivo em `~/.claude/plans/` é só o rascunho do modo de planejamento).

**Goal:** Fazer a Camila (1) nunca mais pedir o nome que já sabe e (2) nunca mais parar de conduzir depois de acolher/informar — corrigindo os dois bugs que a Bruna reportou em 25/07 e o padrão recorrente confirmado no Postgres.

**Architecture:** Duas travas determinísticas no código (nos moldes do `anti-repeat.ts`, que já provou que regra de prompt sozinha falha em produção) + reforço do prompt (v17). (a) **Nome:** o `computeReply` injeta no contexto um bloco `[DADOS DO CONTATO]` com o primeiro nome que já temos (ficha salva → senão o nome do perfil do WhatsApp, filtrado) e a ordem "nunca pergunte o nome de novo". (b) **Condução:** um guard determinístico (`terminaSemAvancar`) detecta resposta que "parou" (sem pergunta e sem ação pendente) e refaz 1x, igual o anti-repeat. O prompt v17 costura os casos que sobram (retomada, pergunta com typo).

**Tech Stack:** TypeScript; prompt como template literal (`src/lib/default-prompt.ts`); funções puras testáveis + wrappers; Gemini `gemini-2.5-flash` via `@google/genai`; testes `tsx` (unit puro com `node:assert`; behavioral com Gemini real via `--env-file=.env.local`). Postgres (`pg`) pro replay dos logs reais. Deploy Railway no push pra `master`.

---

## Contexto (por que esta leva existe)

Reclamação da Bruna (25/07, sobre a conversa salva em `5527981178233` — o "+55 61 94756-9216" do print é o número da clínica visto do celular dela):
1. *"Ela identificou o nome, e perguntou novamente o primeiro."*
2. *"Nesse caso, não continuou a interação depois da informação para um agendamento."*

Evidência crua no log (25/07 12:50): `USER: Individual` → `CAMILA: Entendi, Bruna! ... O pagamento é via Pix. Para que eu possa te ajudar a agendar, qual o seu primeiro nome, por gentileza?` — chama de **"Bruna"** e **pede o nome na mesma frase**. Logo depois (12:51): `USER: Tenho dificuldade para dormir é possível bournat` → `CAMILA: Entendi, Bruna. A dificuldade para dormir é uma questão que pode ser trabalhada na terapia... 😊` — **ignora a pergunta (burnout) e para** (não puxa o próximo passo).

Causas-raiz (verificadas no código atual):
- **Nome:** o bloco `COMO APRESENTAR A INFORMAÇÃO INICIAL` (`default-prompt.ts:54-62`) fixa "Como posso te chamar?" como fecho e o modelo executa cegamente; e o `pushName` do WhatsApp é capturado no webhook (`webhook/route.ts:158`) mas **nunca injetado** no contexto (`conversation.ts:computeReply`), embora o prompt (`:110`) prometa "use o nome que veio do WhatsApp".
- **Condução:** as regras de proatividade (`:118-124`, foco da v16) são probabilísticas e falham em mensagens com carga emocional. Não há trava de código (ao contrário do `anti-repeat.ts`).

Padrão recorrente confirmado nos outros logs reais: **Caroline (20/07)** disse "Quinta de tarde" → `Perfeito, Caroline! Quinta à tarde é uma ótima opção.` e **parou** (ela cobrou "Mas qual é o meu horário?"), depois **pulou pro Pix sem confirmar horário concreto**. **Murilo (23/07)** teve o fluxo perfeito (nome desconhecido → pergunta 1x → conduz até o Pix), confirmando que o bug do nome é **especificamente** o caso "já sei o nome".

Já corrigidos em levas anteriores (só blindar com regressão, NÃO re-mexer): cartão de crédito, "nome completo", inventar política de privacidade de nomes, alucinar horário sem agenda, formulário antes do comprovante, loop "vou enviar em breve".

## File Structure

- **Create** `src/lib/contato.ts` — funções puras do bloco de nome: `primeiroNomeDoPush()`, `blocoContatoDe()`. Responsabilidade única: decidir o primeiro nome e montar o bloco de contexto.
- **Create** `src/lib/conducao.ts` — funções puras do guard de condução: `ehFechamentoLegitimo()`, `pedeAcaoDoPaciente()`, `terminaSemAvancar()`.
- **Modify** `src/lib/anti-repeat.ts` — o wrapper passa a guardar repetição **e** condução numa só passada (máx 2 chamadas ao Gemini). Renomeia pra `runTriagemGuardada`, mantém `runTriagemSemRepeticao` como alias (callers/harness não mudam).
- **Modify** `src/lib/conversation.ts` — `computeReply(waId, pushName?)` carrega o nome salvo (`lead->>'nome'`) e injeta `blocoContatoDe(...)` no system (como a agenda já é injetada).
- **Modify** `src/app/api/whatsapp/webhook/route.ts` — passa o `nome` (pushName) pro `computeReply`.
- **Create** `scripts/test-contato.ts`, `scripts/test-conducao.ts` — units puros (sem Gemini).
- **Modify** `scripts/test-triagem.ts` — campo `system?` no `Cenario` + 4 cenários novos (nome já conhecido; typo burnout; disponibilidade→propõe horário; retomada não re-pergunta).
- **Modify** `scripts/sim-conversa.ts` — persona nova "recorrente-nome-conhecido" (injeta o bloco).
- **Modify** `scripts/replay-conversas.ts` — injeta `blocoContatoDe` por conversa (fidelidade à produção nova).
- **Modify** `src/lib/default-prompt.ts` — prompt v17 + bump de versão.
- **Docs/memória** na Task 8.

---

### Task 1: `contato.ts` — decidir o primeiro nome (TDD)

**Files:**
- Create: `src/lib/contato.ts`
- Create: `scripts/test-contato.ts`

- [ ] **Step 1: Escrever o teste que falha** — `scripts/test-contato.ts`:

```ts
import assert from 'node:assert';
import { primeiroNomeDoPush, blocoContatoDe } from '../src/lib/contato';

// primeiroNomeDoPush: extrai nome de pessoa do pushName livre do WhatsApp
assert.equal(primeiroNomeDoPush('Bruna Amorim'), 'Bruna');
assert.equal(primeiroNomeDoPush('maria 🦋'), 'Maria');
assert.equal(primeiroNomeDoPush('MARIANA'), 'Mariana');
assert.equal(primeiroNomeDoPush('Pedro Silva'), 'Pedro');
assert.equal(primeiroNomeDoPush('Clínica Cazule'), null); // empresa
assert.equal(primeiroNomeDoPush('Loja do João'), null);   // empresa
assert.equal(primeiroNomeDoPush('iPhone de João'), null); // aparelho
assert.equal(primeiroNomeDoPush('😎'), null);
assert.equal(primeiroNomeDoPush(''), null);
assert.equal(primeiroNomeDoPush(undefined), null);

// blocoContatoDe: prioridade ficha > pushName; vazio quando não há nome
const bFicha = blocoContatoDe('Bruna', undefined);
assert.ok(/Bruna/.test(bFicha) && /nunca pergunte o nome/i.test(bFicha), 'ficha: usa nome + proíbe re-perguntar');
const bPush = blocoContatoDe(null, 'Pedro Silva');
assert.ok(/Pedro/.test(bPush) && /whatsapp/i.test(bPush), 'push: usa 1º nome do WhatsApp');
assert.equal(blocoContatoDe(null, null), '');
assert.equal(blocoContatoDe(null, 'Clínica X'), ''); // push filtrado -> sem bloco
assert.equal(blocoContatoDe('  ', undefined), '');    // ficha vazia -> sem bloco

console.log('test-contato: todos os asserts passaram ✔');
```

- [ ] **Step 2: Rodar e ver falhar** — `npx tsx scripts/test-contato.ts` → FALHA (`Cannot find module '../src/lib/contato'`).

- [ ] **Step 3: Implementar** — `src/lib/contato.ts`:

```ts
// Decide o primeiro nome do paciente pra injetar no contexto da Camila e nunca
// mais re-perguntar (bug reportado pela Bruna em 25/07). Funções puras.

/** Palavras que denunciam que o "nome" do WhatsApp é empresa/serviço/aparelho, não pessoa. */
const NAO_E_PESSOA =
  /\b(cl[íi]nica|loja|studio|est[úu]dio|atendimento|comercial|delivery|servi[çc]os?|ltda|mei|oficial|contato|vendas|suporte|imobili[áa]ria|iphone|samsung|galaxy|redmi|xiaomi|motorola)\b/i;

/**
 * Extrai um primeiro nome utilizável do nome de perfil do WhatsApp (pushName).
 * O pushName é livre: pode ser "Maria 🦋", "Loja X", "iPhone de João", "😎".
 * Retorna o primeiro token que pareça nome de pessoa (só letras/acentos), capitalizado,
 * ou null quando não dá pra confiar.
 */
export function primeiroNomeDoPush(pushName?: string | null): string | null {
  if (!pushName) return null;
  if (NAO_E_PESSOA.test(pushName)) return null;
  // mantém só letras (com acento), espaço, hífen e apóstrofo; joga fora emoji/dígitos/símbolos
  const limpo = pushName.replace(/[^\p{L}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!limpo) return null;
  const primeiro = limpo.split(' ')[0];
  if (primeiro.length < 2 || primeiro.length > 20) return null;
  if (/^(de|da|do|dos|das|e)$/i.test(primeiro)) return null;
  return primeiro.charAt(0).toUpperCase() + primeiro.slice(1).toLowerCase();
}

/**
 * Bloco de contexto com o primeiro nome já conhecido. Prioridade: nome da FICHA
 * (o que a pessoa realmente disse / foi extraído) > nome do WhatsApp (pushName).
 * String vazia quando não há nome confiável (aí a Camila pergunta 1x como sempre).
 */
export function blocoContatoDe(nomeFicha?: string | null, pushName?: string | null): string {
  const ficha = nomeFicha && nomeFicha.trim() ? nomeFicha.trim() : null;
  if (ficha) {
    return `[DADOS DO CONTATO]\nVocê já sabe o primeiro nome do paciente: ${ficha}. Use-o com naturalidade e NUNCA pergunte o nome de novo (a etapa 3 do funil já está cumprida). Nunca peça o nome completo — o nome oficial vem no formulário de triagem.`;
  }
  const push = primeiroNomeDoPush(pushName);
  if (push) {
    return `[DADOS DO CONTATO]\nO nome do contato no WhatsApp é "${push}" — provavelmente o primeiro nome da pessoa. Trate-a por esse nome com naturalidade e NÃO peça o primeiro nome (a etapa 3 já está coberta). Se a pessoa se apresentar com outro nome, adote o novo. Nunca peça o nome completo.`;
  }
  return '';
}
```

- [ ] **Step 4: Rodar e ver passar** — `npx tsx scripts/test-contato.ts` → `test-contato: todos os asserts passaram ✔`.

- [ ] **Step 5: Commit** — `git add src/lib/contato.ts scripts/test-contato.ts && git commit -m "feat: contato — 1º nome do pushName/ficha + bloco de contexto (função pura)"`

---

### Task 2: `conducao.ts` — detectar resposta que "parou" (TDD)

**Files:**
- Create: `src/lib/conducao.ts`
- Create: `scripts/test-conducao.ts`

- [ ] **Step 1: Escrever o teste que falha** — `scripts/test-conducao.ts`:

```ts
import assert from 'node:assert';
import { terminaSemAvancar, ehFechamentoLegitimo, pedeAcaoDoPaciente } from '../src/lib/conducao';

// respostas-bug reais que PARARAM (devem ser detectadas)
assert.equal(terminaSemAvancar('Entendi, Bruna. A dificuldade para dormir pode ser trabalhada na terapia, sim. 😊'), true);
assert.equal(terminaSemAvancar('Perfeito, Caroline! Quinta à tarde é uma ótima opção.'), true);
assert.equal(terminaSemAvancar('Obrigada, Bruna! 😊'), true);

// respostas que AVANÇAM (não devem disparar)
assert.equal(terminaSemAvancar('Quais dias e horários costumam ser melhores pra você?'), false);
assert.equal(terminaSemAvancar('A quinta às 14h com a Bruna Ferreira está livre, quer que eu reserve?'), false);

// fechamentos/limites legítimos (não é bug parar)
assert.equal(ehFechamentoLegitimo('Combinado! Fico à disposição, qualquer coisa me chama 😊'), true);
assert.equal(terminaSemAvancar('Combinado! Fico à disposição 😊'), false);

// pedido de ação do paciente (Passo 3) conta como avanço, mesmo sem "?"
assert.equal(pedeAcaoDoPaciente('Assim que fizer o pagamento, me envie o comprovante por aqui.'), true);
assert.equal(terminaSemAvancar('Assim que fizer o pagamento, me envie o comprovante por aqui.'), false);

// vazio não dispara (tratado noutro lugar)
assert.equal(terminaSemAvancar(''), false);

console.log('test-conducao: todos os asserts passaram ✔');
```

- [ ] **Step 2: Rodar e ver falhar** — `npx tsx scripts/test-conducao.ts` → FALHA (módulo inexistente).

- [ ] **Step 3: Implementar** — `src/lib/conducao.ts`:

```ts
// Guard determinístico de CONDUÇÃO: detecta quando a Camila "parou" (acolheu/
// informou e não puxou o próximo passo) — bug reportado pela Bruna em 25/07 e
// recorrente nos logs. Regra de prompt é probabilística; esta camada garante.

/** Fechamento/limite legítimo: aí é OK a resposta não ter pergunta. */
const FECHAMENTO =
  /(à|a) disposi[çc]|te chamo por aqui|qualquer coisa (é só )?(me )?cham|fico no aguardo|estou (por aqui|à disposi)|mantermos o respeito/i;

/** Passo 3 (Pix/comprovante): pedir a ação do paciente conta como avanço, mesmo sem "?". */
const PEDE_ACAO =
  /comprovante|me (envie|manda|envia|mande)|assim que (voc[êe] )?(fizer|pagar|realizar)|chave (pix|do pix)|dados (do|para o) (pagamento|pix)/i;

export function ehFechamentoLegitimo(resposta: string): boolean {
  return FECHAMENTO.test(resposta ?? '');
}

export function pedeAcaoDoPaciente(resposta: string): boolean {
  return PEDE_ACAO.test(resposta ?? '');
}

/**
 * true se a resposta NÃO avança o funil: sem pergunta ("?"), e não é fechamento
 * legítimo nem pedido de ação (Pix/comprovante). Vazio retorna false (o caller
 * trata resposta vazia com a mensagem amigável).
 */
export function terminaSemAvancar(resposta: string): boolean {
  const r = (resposta ?? '').trim();
  if (!r) return false;
  if (r.includes('?')) return false;
  if (ehFechamentoLegitimo(r)) return false;
  if (pedeAcaoDoPaciente(r)) return false;
  return true;
}
```

- [ ] **Step 4: Rodar e ver passar** — `npx tsx scripts/test-conducao.ts` → `test-conducao: todos os asserts passaram ✔`.

- [ ] **Step 5: Commit** — `git add src/lib/conducao.ts scripts/test-conducao.ts && git commit -m "feat: conducao — detector puro de resposta que nao avanca o funil"`

---

### Task 3: guard combinado (repetição + condução) no `anti-repeat.ts`

**Files:**
- Modify: `src/lib/anti-repeat.ts`

- [ ] **Step 1: Importar o detector de condução** — logo abaixo do import de `./triagem`, adicionar:

```ts
import { terminaSemAvancar } from './conducao';
```

- [ ] **Step 2: Adicionar o aviso de condução** — logo após a constante `AVISO_RETRY` existente, adicionar:

```ts
const AVISO_AVANCAR = `

[AVISO DO SISTEMA — só neste turno]: a resposta que você tentou enviar NÃO puxou o próximo passo (terminou sem uma pergunta que conduza a conversa). Isso é proibido no meio do atendimento. Gere uma resposta NOVA que:
- responda por INTEIRO o que o paciente trouxe (inclusive a pergunta que ele fez), acolhendo primeiro se for uma dor;
- e TERMINE puxando a próxima etapa pendente com UMA pergunta leve — nome só se ainda não souber; senão motivação, disponibilidade, ou propor um horário concreto da agenda.
Nunca encerre no acolhimento nem pare esperando o paciente dizer "ok".`;
```

- [ ] **Step 3: Reescrever o wrapper** — substituir a função `runTriagemSemRepeticao` inteira (do comentário `/**` até o `}` final) por:

```ts
/**
 * runTriagem com duas travas determinísticas numa passada só (máx 2 chamadas ao
 * Gemini): se a resposta (a) sair igual/quase à última mensagem da assistente OU
 * (b) não puxar o próximo passo do funil (e não for handoff/fechamento), refaz
 * UMA vez com o(s) aviso(s) certo(s). Loga se persistir. Nunca entra em loop.
 */
export async function runTriagemGuardada(input: TriagemInput): Promise<TriagemResult> {
  const anterior = [...input.messages].reverse().find((m) => m.role === 'assistant')?.content;
  const primeira = await runTriagem(input);

  const repetiu = ehRepeticao(primeira.resposta, anterior);
  // só cobra avanço no meio do funil: nunca no handoff (enviarForm)
  const parou = !primeira.enviarForm && terminaSemAvancar(primeira.resposta);
  if (!repetiu && !parou) return primeira;

  let aviso = '';
  if (repetiu) aviso += AVISO_RETRY;
  if (parou) aviso += AVISO_AVANCAR;
  console.warn(`[guard] refazendo (repetiu=${repetiu}, parou=${parou})`);
  const segunda = await runTriagem({ ...input, system: input.system + aviso });
  if (ehRepeticao(segunda.resposta, anterior)) {
    console.error('[guard] repetição persistiu após retry — enviando a 2ª tentativa mesmo assim');
  }
  if (!segunda.enviarForm && terminaSemAvancar(segunda.resposta)) {
    console.error('[guard] resposta ainda não avança após retry — enviando mesmo assim');
  }
  return segunda;
}

/** Compat: nome antigo usado pela route, webhook e harness de testes. */
export const runTriagemSemRepeticao = runTriagemGuardada;
```

- [ ] **Step 4: Sanidade dos units puros** — `npx tsx scripts/test-anti-repeat.ts` → verde (as funções puras `ehRepeticao`/`similaridade` não mudaram). Se `test-anti-repeat.ts` importar `runTriagemSemRepeticao`, o alias mantém compatível.

- [ ] **Step 5: Commit** — `git add src/lib/anti-repeat.ts && git commit -m "feat: guard combinado — anti-repeticao + anti-parada (refaz 1x)"`

---

### Task 4: injetar o nome no contexto (`computeReply` + webhook)

**Files:**
- Modify: `src/lib/conversation.ts`
- Modify: `src/app/api/whatsapp/webhook/route.ts`

- [ ] **Step 1: Importar o bloco de contato** — em `src/lib/conversation.ts`, junto aos outros imports do topo, adicionar:

```ts
import { blocoContatoDe } from './contato';
```

- [ ] **Step 2: Loader do nome salvo** — adicionar esta função logo após `loadHistory` (perto da linha 66):

```ts
/** Primeiro nome já extraído pra este número (o que a pessoa disse), ou null. */
async function loadNomeFicha(waId: string): Promise<string | null> {
  try {
    const { rows } = await query<{ nome: string | null }>(
      `SELECT lead->>'nome' AS nome FROM wa_conversations WHERE wa_id = $1`,
      [waId],
    );
    return rows[0]?.nome?.trim() || null;
  } catch (e) {
    console.error('[conversation] loadNomeFicha falhou', e);
    return null;
  }
}
```

- [ ] **Step 3: Mudar a assinatura + injetar o bloco** — em `computeReply`, trocar a linha:

`export async function computeReply(waId: string): Promise<TurnoResposta & { enviarForm: boolean }> {`

por:

`export async function computeReply(waId: string, pushName?: string): Promise<TurnoResposta & { enviarForm: boolean }> {`

e, logo após o bloco que anexa a agenda (`if (agenda) system = \`${system}\n\n${agenda}\`;`), adicionar:

```ts
  // Nome já conhecido (ficha > pushName do WhatsApp): injeta no contexto pra a
  // Camila cumprimentar pelo nome e NUNCA re-perguntar (bug reportado 25/07).
  const contato = blocoContatoDe(await loadNomeFicha(waId), pushName);
  if (contato) system = `${system}\n\n${contato}`;
```

- [ ] **Step 4: Passar o pushName no webhook** — em `src/app/api/whatsapp/webhook/route.ts`, trocar a chamada (linha ~193):

`turno = await computeReply(from);`

por:

`turno = await computeReply(from, nome);`

(`nome` já é `value?.contacts?.[0]?.profile?.name`, capturado na linha 158.)

- [ ] **Step 5: Conferir o outro caller** — abrir `src/app/api/chat/route.ts` e confirmar: se ele chama `computeReply(waId)`, nada muda (o `pushName` é opcional); se ele chama `runTriagem`/`runTriagemSemRepeticao` direto, também não quebra. Não editar salvo se estiver quebrado.

- [ ] **Step 6: Build de sanidade** — `pnpm build` → verde (garante que a mudança de assinatura não quebrou tipos).

- [ ] **Step 7: Commit** — `git add src/lib/conversation.ts src/app/api/whatsapp/webhook/route.ts && git commit -m "feat: computeReply injeta o 1o nome conhecido (ficha/pushName) no contexto"`

---

### Task 5: cenários behavioral (Gemini) — nome, typo, condução, retomada

**Files:**
- Modify: `scripts/test-triagem.ts`
- Modify: `scripts/sim-conversa.ts`
- Modify: `scripts/replay-conversas.ts`

- [ ] **Step 1: test-triagem — imports + `system?` no Cenario** — no topo (junto aos imports), adicionar:

```ts
import { blocoContatoDe } from '../src/lib/contato';
```

e na interface `Cenario`, adicionar o campo opcional (após `nome: string;`):

```ts
  /** system alternativo (ex.: com bloco [DADOS DO CONTATO]); default = SYSTEM. */
  system?: string;
```

e em `rodarCenario`, trocar a linha `const res = await runTriagemSemRepeticao({ system: SYSTEM, messages: history });` por:

```ts
    const res = await runTriagemSemRepeticao({ system: c.system ?? SYSTEM, messages: history });
```

- [ ] **Step 2: test-triagem — 4 cenários novos** — inserir antes do `];` que fecha `cenarios`:

```ts
  {
    nome: 'ja sabe o nome -> NAO re-pergunta (bug 25/07)',
    system: SYSTEM + '\n\n' + blocoContatoDe('Bruna', undefined),
    falas: ['Gostaria de terapia', 'Individual', 'existem profissionais com foco em abordagens diferentes?'],
    checar: (t) => {
      const todas = todasRespostas(t);
      const pediuNome = /como.*(te chamar|posso te chamar)|seu (primeiro )?nome|qual.*\bnome\b/i.test(todas);
      const usouNome = /bruna/i.test(todas);
      return { ok: !pediuNome && usouNome, nota: `pediuNome=${pediuNome} (esperado false) usouNome=${usouNome} | "${ultimo(t).resposta.slice(0, 140)}"` };
    },
  },
  {
    nome: 'retomada com nome+modalidade -> nao re-pergunta individual/casal nem nome',
    system: SYSTEM + '\n\n' + blocoContatoDe('Marina', undefined),
    falas: ['oi, tudo bem?', 'gostaria de saber os valores da individual'],
    checar: (t) => {
      const todas = todasRespostas(t);
      const perguntouModalidade = /individual ou (de )?casal/i.test(todas);
      const pediuNome = /como.*(te chamar|posso te chamar)|seu (primeiro )?nome/i.test(todas);
      const informou = informaValor(todas);
      return { ok: !perguntouModalidade && !pediuNome && informou, nota: `modalidade=${perguntouModalidade} pediuNome=${pediuNome} informou=${informou} | "${ultimo(t).resposta.slice(0, 140)}"` };
    },
  },
  {
    nome: 'pergunta com typo (bournat=burnout) -> aborda a pergunta e conduz',
    falas: ['oi, quero uma sessao individual', 'meu nome é Helena', 'Tenho dificuldade para dormir é possível bournat'],
    checar: (t) => {
      const ultima = ultimo(t).resposta;
      const abordou = /burnout|esgotamento|é possível|d[áa] pra (investigar|cuidar|trabalhar)|pode (ser|estar) (ligad|relacion)|trabalhad[ao]/i.test(ultima);
      const puxou = /\?/.test(ultima);
      const naoDiagnosticou = !/voc[êe] (tem|est[áa] com) burnout|é burnout sim/i.test(ultima);
      return { ok: abordou && puxou && naoDiagnosticou, nota: `abordou=${abordou} puxou=${puxou} semDiagnostico=${naoDiagnosticou} | "${ultima.slice(0, 160)}"` };
    },
  },
  {
    nome: 'deu disponibilidade -> propoe horario concreto (nao para) [bug 20/07]',
    falas: ['oi, quero uma sessao individual', 'meu nome é Helena, ando ansiosa', 'quinta à tarde'],
    checar: (t) => {
      const ultima = ultimo(t).resposta;
      // agenda fake: Bruna Ferreira quinta 14:00-19:00 -> deve propor slot concreto
      const propos = /\b1[4-9]h|1[4-9]:00|reserv/i.test(ultima);
      const puxou = /\?/.test(ultima) || /reserv/i.test(ultima);
      return { ok: propos && puxou, nota: `propos=${propos} puxou=${puxou} | "${ultima.slice(0, 160)}"` };
    },
  },
```

- [ ] **Step 3: sim-conversa — persona recorrente** — em `scripts/sim-conversa.ts`, adicionar o import (junto aos outros):

```ts
import { blocoContatoDe } from '../src/lib/contato';
```

adicionar o campo `comNome?` na interface `Persona` (após `comAgenda?: boolean;`):

```ts
  /** primeiro nome já conhecido (injeta [DADOS DO CONTATO] no system). */
  comNome?: string;
```

na função `rodarPersona`, trocar `const system = persona.comAgenda ? SYSTEM_COM_AGENDA : SYSTEM;` por:

```ts
  let system = persona.comAgenda ? SYSTEM_COM_AGENDA : SYSTEM;
  if (persona.comNome) system = `${system}\n\n${blocoContatoDe(persona.comNome, undefined)}`;
```

adicionar a persona (perto das outras constantes de persona):

```ts
const PACIENTE_RECORRENTE: Persona = {
  nome: 'recorrente-nome-conhecido (nao re-perguntar nome)',
  comNome: 'Bruna',
  comAgenda: true,
  system: `Você simula uma PACIENTE recorrente no WhatsApp de uma clínica de psicologia.
Persona: Bruna, já conversou antes (a clínica já sabe seu nome). Hoje volta querendo terapia individual.
Fluxo: "gostaria de terapia" -> "individual" -> pergunte sobre as abordagens -> diga que tem dificuldade pra dormir e pergunte se pode ser burnout -> aceite agendar e escolha um horário proposto.
Escreva curto, PT-BR, uma mensagem por vez. Responda SOMENTE a próxima fala, sem aspas.`,
  maxTurnos: 9,
  encerra: () => false,
};
```

e incluí-la no array `personas` do `main` (adicionar `PACIENTE_RECORRENTE` ao final da lista).

- [ ] **Step 4: replay-conversas — injetar o nome por conversa** — em `scripts/replay-conversas.ts`: adicionar o import:

```ts
import { blocoContatoDe } from '../src/lib/contato';
```

após o `SELECT ... FROM wa_messages ...`, buscar o nome de cada conversa:

```ts
  const nomes = await db.query<{ wa_id: string; nome: string | null }>(
    `SELECT wa_id, lead->>'nome' AS nome FROM wa_conversations`,
  );
  const nomePorConversa = new Map(nomes.rows.map((r) => [r.wa_id, r.nome]));
```

(mover o `await db.end();` pra depois desse segundo query). Dentro do loop `for (const [waId, msgs] of porConversa)`, montar o system por conversa antes de rodar os turnos:

```ts
    const contato = blocoContatoDe(nomePorConversa.get(waId) ?? null, null);
    const systemConv = contato ? `${system}\n\n${contato}` : system;
```

e trocar as duas chamadas `runTriagemSemRepeticao({ system, messages: history })` por `runTriagemSemRepeticao({ system: systemConv, messages: history })`.

- [ ] **Step 5: Rodar a suíte contra o estado atual** — `npx tsx --env-file=.env.local scripts/test-triagem.ts`. Esperado: `ja sabe o nome` e `retomada` já passam (fixes de código das Tasks 3–4 valem porque o harness usa `runTriagemSemRepeticao`); `typo burnout` e `disponibilidade→propõe` podem oscilar até a Task 6. Protocolo de flake: null/rede → re-rodar 1x.

- [ ] **Step 6: Commit** — `git add scripts/test-triagem.ts scripts/sim-conversa.ts scripts/replay-conversas.ts && git commit -m "test: cenarios de nome-conhecido, typo, conducao e retomada (Gemini + replay real)"`

---

### Task 6: Prompt v17 — pula nome conhecido, responde a pergunta real, retomada

**Files:**
- Modify: `src/lib/default-prompt.ts`

- [ ] **Step 1: Regra "responda a pergunta que a pessoa fez"** — no bloco TOM, logo após o bullet que começa com `- NÃO fique presa numa pergunta.`, inserir:

```
- RESPONDA A PERGUNTA QUE A PESSOA FEZ. Se ela pergunta se um problema/condição pode ser cuidado na terapia (ex.: "é possível burnout?", "isso tem a ver com ansiedade?", "vocês tratam depressão?") — MESMO com erro de digitação ("bournat" = burnout, "sindrome do panico", "insonia") — reconheça o assunto que ela citou SEM dar diagnóstico ("sim, é algo que dá pra investigar e cuidar na terapia, viu?") e JÁ emende o próximo passo. Nunca responda só uma parte (ex.: falar do sono e ignorar o "burnout" que ela perguntou) nem deixe a pergunta dela sem resposta.
```

- [ ] **Step 2: REGRA DE OURO da retomada (trocar nome-exemplo "Bruna" e reforçar)** — substituir o bullet que começa com `- REGRA DE OURO da retomada:` (linha ~34) por:

```
- REGRA DE OURO da retomada: ANTES de responder, olhe o histórico. Se a pessoa JÁ apareceu antes (nome, modalidade, agendamento, conversa anterior — mesmo dias atrás), NUNCA reabra com o script de primeiro contato ("Seja bem-vindo(a) à Cazule. Me chamo Camila...") nem re-pergunte o que já sabe: NÃO re-pergunte "individual ou casal" se ela já disse a modalidade, e NÃO re-pergunte o nome se você já o tem. Cumprimente pelo nome e responda direto, engatando a próxima etapa PENDENTE. Ex. do que NÃO fazer: a Marina já tem nome e modalidade no histórico, volta com "gostaria de saber valores" e você responde "Seja bem-vinda à Cazule... é individual ou de casal?" — o certo é "Oi, Marina! Claro: a individual avulsa é R$ 75,00 e o pacote mensal R$ 280,00 (ela já disse que é individual). Quais dias e horários costumam ser melhores pra você?"
```

- [ ] **Step 3: Trocar o nome-exemplo "Bruna" da psicóloga (evita colisão paciente/psicóloga)** — no Passo 2 (linha ~131), trocar `"a quinta às 18h está livre com a Bruna, quer que eu reserve?"` por `"a quinta às 18h está livre com a Larissa, quer que eu reserve?"`.

- [ ] **Step 4: Bullet do primeiro nome (pular se já sabe)** — substituir o bullet que começa com `- Primeiro nome, só pra saber como chamar` (linha ~110) por:

```
- Primeiro nome, só pra saber como chamar a pessoa. SE VOCÊ JÁ SABE O NOME (a pessoa já disse antes, está na ficha, ou há um bloco [DADOS DO CONTATO] no contexto), NÃO pergunte o nome de novo em NENHUMA hipótese — trate a pessoa pelo nome e pule pra próxima etapa. É contraditório e passa impressão de robô cumprimentar pelo nome ("Entendi, Marina!") e no mesmo turno perguntar o nome — nunca faça isso. Só se ainda NÃO souber o nome, pergunte de leve UMA vez ("como posso te chamar?"). NUNCA peça o nome "completo" e NUNCA insista se vier abreviado ("Murilo" ou "Murilo M" já está ótimo) — o nome oficial é coletado no formulário no fim. Nunca trave a conversa por causa do nome.
```

- [ ] **Step 5: Info inicial — fecho condicional ao nome** — substituir a primeira frase do bloco `COMO APRESENTAR A INFORMAÇÃO INICIAL` (linha ~54), de:

`COMO APRESENTAR A INFORMAÇÃO INICIAL (quando for passar os valores): NUNCA num bloco só, mas também NUNCA pela metade — dê a informação COMPLETA (modalidade + duração + os DOIS valores + pagamento) repartida em 2 a 3 bolhas, TODAS no mesmo turno (separadas por LINHA EM BRANCO), e SEMPRE termine puxando a próxima etapa. Modelo individual (cada linha em branco vira uma bolha):`

para:

`COMO APRESENTAR A INFORMAÇÃO INICIAL (quando for passar os valores): NUNCA num bloco só, mas também NUNCA pela metade — dê a informação COMPLETA (modalidade + duração + os DOIS valores + pagamento) repartida em 2 a 3 bolhas, TODAS no mesmo turno (separadas por LINHA EM BRANCO), e SEMPRE termine puxando a próxima etapa PENDENTE. A ÚLTIMA bolha é essa próxima pergunta: se você AINDA NÃO SABE o primeiro nome, pergunte "Como posso te chamar?"; se JÁ SABE o nome, NÃO pergunte o nome — pule pra próxima etapa (o que a trouxe à terapia, ou a disponibilidade), tratando a pessoa pelo nome. Modelo individual quando ainda NÃO sabe o nome (cada linha em branco vira uma bolha):`

- [ ] **Step 6: PIPELINE — etapa 3 pulável** — substituir a linha das etapas (linha ~119), de:

`As etapas do funil são: (1) modalidade → (2) valores → (3) primeiro nome (leve, sem cobrar completo) → (4) queixa/motivação → (5) disponibilidade → (6) proposta de horário concreto da agenda → (7) avulsa ou pacote → (8) Pix + comprovante → (9) confirmação + formulário.`

para:

`As etapas do funil são: (1) modalidade → (2) valores → (3) primeiro nome (leve, sem cobrar completo — PULE se já souber o nome) → (4) queixa/motivação → (5) disponibilidade → (6) proposta de horário concreto da agenda → (7) avulsa ou pacote → (8) Pix + comprovante → (9) confirmação + formulário. Uma etapa já cumprida (inclusive por dados que você já tem, como o nome) é PULADA — puxe sempre a próxima que ainda está pendente, nunca uma já resolvida.`

- [ ] **Step 7: Bump da versão** — trocar:

`export const PROMPT_VERSION = '2026-07-23-cazule-v16-proatividade-e-baloes';`

por:

`export const PROMPT_VERSION = '2026-07-25-cazule-v17-nome-conhecido-e-conducao';`

- [ ] **Step 8: Commit** — `git add src/lib/default-prompt.ts && git commit -m "feat: prompt v17 — pula nome conhecido, responde a pergunta real, retomada firme"`

---

### Task 7: Verificação (units + suítes Gemini + replay + avaliação Fable + build)

**Files:** nenhum (só execução) — este é o "rode suites e testes com conversas simuladas de vários ângulos".

- [ ] **Step 1: Units puros** — `npx tsx scripts/test-contato.ts && npx tsx scripts/test-conducao.ts && npx tsx scripts/test-split.ts && npx tsx scripts/test-comprovante-core.ts && npx tsx scripts/test-anti-repeat.ts && npx tsx scripts/test-parse-modelo.ts && npx tsx scripts/test-agenda.ts && npx tsx scripts/test-followup.ts` → todos verdes.

- [ ] **Step 2: Suíte de triagem** — `npx tsx --env-file=.env.local scripts/test-triagem.ts` → todos verdes, incluindo os 4 novos. Flake conhecido (`pronto` no luto/Lucas) → re-rodar 1x se for a única falha.

- [ ] **Step 3: Simulação multi-persona (vários ângulos)** — `npx tsx --env-file=.env.local scripts/sim-conversa.ts` (todas as personas, incl. a nova `recorrente-nome-conhecido`). Conferir no log: (a) na recorrente, a Camila NUNCA pede o nome e trata por "Bruna"; (b) ninguém fica esperando "ok" — toda resposta puxa o próximo passo; (c) a pergunta com typo (burnout) é reconhecida.

- [ ] **Step 4: Replay dos logs reais** — obter o `DATABASE_PUBLIC_URL` (`railway variables -s Postgres --json`) e rodar `DATABASE_PUBLIC_URL=... npx tsx --env-file=.env.local scripts/replay-conversas.ts`. Conferir nos turnos-bug: (a) 25/07 (`5527981178233`) — após "Individual" a NOVA resposta NÃO pede o nome (bloco com "Bruna"); no turno do burnout, a NOVA aborda a pergunta e puxa o próximo passo; (b) 20/07 (`555496803332`) — após "quinta de tarde", a NOVA propõe horário concreto em vez de parar.

- [ ] **Step 5: Avaliação Fable (multi-agente, opcional mas recomendado por ultracode)** — salvar as transcrições dos Steps 3–4 e avaliar com um Workflow que faz fan-out por dimensão (consistência do nome, condução/nunca-para, compreensão da pergunta, tom humano, integridade do funil) e verifica os achados de forma adversarial; sintetizar as correções e, se houver regressão, iterar (voltar à Task 6). Metodologia consagrada do projeto: sim/replay Gemini → avaliação Fable → correção Opus → re-testar.

- [ ] **Step 6: Build** — `pnpm build` → verde.

---

### Task 8: Deploy + teste real + docs + memória

**Files:**
- Modify: `CONTEXTO-CAZULE.md` (Leva 10)
- Create: `docs/superpowers/plans/2026-07-25-camila-nome-e-conducao.md` (cópia deste plano)
- Create: `mensagem-bruna-v17.md`
- Memória: `cazule-projeto.md`, `cazule-integracoes.md`, `MEMORY.md`

- [ ] **Step 1: Deploy** — `gh auth switch --user vertechsolutions && gh auth setup-git && git push origin master`; monitorar `railway deployment list --json` até o commit novo aparecer com `status: SUCCESS`; então `GET /api/health` → 200. (Auto-deploy dispara: os arquivos tocados estão em `src/**`.)

- [ ] **Step 2: Teste real dirigido** — testar do número do Murilo (`5549999551051`). Com o pushName do Murilo ativo, conferir: (a) a Camila cumprimenta e conduz SEM pedir o nome (já veio do WhatsApp); (b) ao dar uma dor/queixa, acolhe E continua no mesmo turno; (c) uma pergunta como "isso pode ser burnout?" é respondida e puxa o próximo passo. Reset opcional da conversa: `DELETE /api/admin/patient?waId=5549999551051` (endpoint admin) antes de começar limpo. NÃO apagar a conversa real da Bruna (`5527981178233`) sem pedir.

- [ ] **Step 3: Docs + memória** — Leva 10 no `CONTEXTO-CAZULE.md`; atualizar `cazule-projeto.md` (nova leva v17), `cazule-integracoes.md` (versão no ar) e `MEMORY.md`; copiar este plano pra `docs/superpowers/plans/2026-07-25-camila-nome-e-conducao.md`; escrever `mensagem-bruna-v17.md` (formatação WhatsApp) explicando os 2 ajustes.

- [ ] **Step 4: Commit docs + push** — `git add CONTEXTO-CAZULE.md docs/superpowers/plans/2026-07-25-camila-nome-e-conducao.md mensagem-bruna-v17.md && git commit -m "docs: Leva 10 — nome conhecido + conducao (v17)" && git push origin master` (docs não redeploya; watchPatterns só cobre `src/**`, `public/**`, `package.json`, `next.config.ts`).

---

## Verificação final (checklist da leva)

- Units verdes: `test-contato`, `test-conducao`, `test-split`, `test-comprovante-core`, `test-anti-repeat`, `test-parse-modelo`, `test-agenda`, `test-followup`.
- `test-triagem` verde incl. os 4 novos (nome-conhecido, retomada, typo-burnout, disponibilidade→horário).
- `sim-conversa` (todas as personas): recorrente não re-pergunta o nome; ninguém para; typo reconhecido.
- `replay-conversas`: nos turnos-bug reais de 25/07 e 20/07 a resposta NOVA corrige (não pede nome / propõe horário / aborda a pergunta).
- `pnpm build` verde · deploy SUCCESS · `/api/health` 200.
- Teste real: nome nunca é re-perguntado; acolhe e continua; pergunta real respondida.

## Riscos e mitigação

- **pushName ruim ("iPhone de João", "Loja X")**: `primeiroNomeDoPush` filtra empresa/aparelho/emoji; se filtrar tudo, cai no comportamento antigo (pergunta 1x). A ficha (o que a pessoa disse) sempre tem prioridade sobre o pushName.
- **Guard de condução fazer refire à toa** (custo de +1 chamada Gemini): só dispara quando NÃO há "?", NÃO é fechamento legítimo e NÃO é pedido de ação (Pix/comprovante); nunca no handoff (`enviarForm`). No pior caso o refire gera uma resposta equivalente melhor. Volume da clínica é baixo → custo aceitável.
- **Nome injetado forçar a Camila a assumir um nome errado**: o bloco de pushName diz "provavelmente o primeiro nome; se a pessoa se apresentar com outro, adote o novo" — não trava. A ficha só entra quando o modelo já extraiu o nome de fato.
- **Lag de 1 turno na ficha**: no turno em que a pessoa diz o nome, o bloco ainda não existe (a ficha é gravada em `persistReply`), mas o nome está no histórico daquele turno; a partir do turno seguinte o bloco garante. Sem impacto prático.
- **Prompt v17 já longo (~160 linhas) ganhar mais regras** (diluição): as travas críticas (nome, condução) agora são de CÓDIGO — o prompt é reforço, não a única linha de defesa. Lição das levas 5/8: não enfatizar brevidade a ponto de truncar; foco segue em completude + puxar o próximo passo.
- **`app_config` sobrescreve o prompt do código**: confirmar `app_config` vazio antes do deploy (esteve vazio nas últimas levas) — senão o v17 do código não vale.
```
