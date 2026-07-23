# Proatividade + balões/formatação das mensagens da Camila (v16)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> Ao iniciar a execução, copie este plano para `docs/superpowers/plans/2026-07-23-camila-proatividade-e-baloes.md`.

## Context

Do teste real do Murilo (log da conversa 554999551051, v15) saíram dois problemas concretos:

1. **Proatividade caiu** — em dois pontos a Camila **parou e esperou** o paciente em vez de conduzir:
   - Depois da info inicial (*"...O pagamento é via Pix."*) ela não emendou o próximo passo; o paciente teve que dizer "Ok" pra ela puxar o nome.
   - Depois de acolher a queixa (*"Sinto muito que esteja passando por isso... buscar ajuda"*) ela parou de novo; o paciente teve que digitar "(Faltou continuar a conversa)".
   - Causa raiz: a regra "exceção de ritmo" (acolher dor sem pergunta colada) está sendo lida como "acolhe e **espera**"; e o exemplo da info inicial termina sem puxar o próximo passo.
2. **Balões/formatação** — todas as respostas vieram em **uma bolha só** (o modelo nunca colou `\n\n`). O `splitReply` (`src/lib/split-message.ts`) só quebra automaticamente acima de **550 caracteres**, e a info inicial tem ~240 → fica corrida. O usuário quer mensagens quebradas em **2–3 balões** (ele escolheu "Camila decide 2–3") e, quando há uma lista (valores, etapas, opções), **tópicos/bullets** pra facilitar a leitura.

**Outcome esperado:** a Camila conduz o funil de ponta a ponta sem parar (acolhe **e** puxa o próximo passo no mesmo turno), e entrega as respostas em 2–3 balões curtos, usando tópicos quando há uma lista — mantendo o tom humano (nada de "formulário").

## Architecture

Alavanca principal é o **prompt** (`src/lib/default-prompt.ts`): o modelo decide onde quebrar (via `\n\n`) e quando puxar a próxima etapa — corrigimos os exemplos (que hoje mostram fala corrida sem próximo passo) e reforçamos a condução. Como rede de segurança, reduzimos o teto de tamanho do `splitReply` (`DEFAULT_MAX_LEN` 550 → 350) pra o código quebrar respostas longas mesmo se o modelo escorregar. Os balões já são enviados por `sendTextSequence` (900ms entre eles) — nada muda ali. Testes: `test-split` (novo teto) + `test-triagem` com asserts que usam `splitReply()` pra medir balões e checam proatividade.

## Tech Stack

TypeScript; prompt como template literal; `splitReply()` (função pura) + `sendTextSequence`; testes `tsx` + `node:assert` com Gemini real (`--env-file=.env.local`). Deploy Railway no push pra `master`.

---

### Task 1: Testes primeiro (TDD — red)

**Files:**
- Modify: `scripts/test-split.ts` (1 caso novo)
- Modify: `scripts/test-triagem.ts` (2 cenários novos + import de `splitReply`)

- [ ] **Step 1: test-split — caso do novo teto** — adicionar antes do `console.log` final:

```ts
// 9) com o default novo (350), um bloco corrido longo (> 350 chars, sem \n\n)
//    quebra em 2+ bolhas por frase
const corridoLongo =
  'As sessões são online, por chamada de vídeo, com duração de 45 minutos. ' +
  'A avulsa é R$ 75,00 e o pacote mensal de 4 sessões sai por R$ 280,00, com desconto. ' +
  'Também temos a opção quinzenal, com 2 sessões por mês, por R$ 150,00. ' +
  'O pagamento é via Pix, e assim que você me enviar o comprovante eu já reservo o seu horário. ' +
  'Você prefere atendimento individual ou de casal, pra eu te passar os detalhes certinhos?';
assert.ok(corridoLongo.length > 350, 'sanity: o texto de teste deve passar do teto');
const bolhas = splitReply(corridoLongo);
assert.ok(bolhas.length >= 2, 'bloco corrido > 350 deve virar 2+ bolhas com o default novo');
assert.ok(bolhas.every((b) => b.length <= 350), 'toda bolha respeita o teto default de 350');
```

- [ ] **Step 2: test-triagem — import** — no topo, junto aos outros imports, adicionar:

```ts
import { splitReply } from '../src/lib/split-message';
```

- [ ] **Step 3: test-triagem — 2 cenários** — inserir antes do `];` que fecha `cenarios`:

```ts
  {
    nome: 'info inicial -> quebra em bolhas e ja puxa o proximo passo',
    falas: ['oi, quero uma sessao individual'],
    checar: (t) => {
      const resp = ultimo(t).resposta;
      const bolhas = splitReply(resp).length;
      const puxou = /chamar|seu nome|te trouxe|motivou|individual ou.*casal|\?/i.test(resp);
      return { ok: bolhas >= 2 && puxou, nota: `bolhas=${bolhas} puxouProximo=${puxou} | "${resp.slice(0, 160)}"` };
    },
  },
  {
    nome: 'acolhe a dor e CONTINUA no mesmo turno (nao para)',
    falas: ['oi, quero uma sessao individual', 'meu nome é Murilo', 'ando muito pra baixo, acho que é depressao'],
    checar: (t) => {
      const resp = ultimo(t).resposta;
      const acolheu = /sinto muito|imagino|que bom que|passo importante|difícil|dif[íi]cil/i.test(resp);
      const puxou = /dia|hor[áa]rio|per[íi]odo|melhor.*(voc[êe]|pra você)|agendar|\?/i.test(resp);
      return { ok: acolheu && puxou, nota: `acolheu=${acolheu} puxouProximo=${puxou} | "${resp.slice(0, 160)}"` };
    },
  },
```

- [ ] **Step 4: Rodar e ver falhar** — `npx tsx --env-file=.env.local scripts/test-triagem.ts` → o cenário `info inicial -> quebra em bolhas` FALHA (v15 manda 1 bolha só e não puxa) e `acolhe a dor e CONTINUA` FALHA (v15 para no acolhimento). Protocolo de flake: campos null / rede → re-rodar 1x.

- [ ] **Step 5: Commit** — `git add scripts/test-split.ts scripts/test-triagem.ts && git commit -m "test: bolhas (splitReply>=2) + proatividade (acolhe e continua)"`

---

### Task 2: Código — teto do split (backstop de balões)

**Files:**
- Modify: `src/lib/split-message.ts`

- [ ] **Step 1: Reduzir o teto default** — trocar `const DEFAULT_MAX_LEN = 550;` por `const DEFAULT_MAX_LEN = 350;`

- [ ] **Step 2: Atualizar o comentário do campo** — na interface `SplitOpts`, trocar a linha do `maxLen`:

de:
`  /** tamanho máximo de cada bolha (chars). WhatsApp aguenta 4096; 550 é confortável. */`

para:
`  /** tamanho máximo de cada bolha (chars). WhatsApp aguenta 4096; 350 mantém as bolhas curtas (backstop; o ideal é o modelo quebrar com linha em branco). */`

- [ ] **Step 3: Rodar test-split** — `npx tsx scripts/test-split.ts` → todos verdes (o caso 9 novo passa; casos 1–8 usam `maxLen` explícito ou texto curto, não regridem).

- [ ] **Step 4: Commit** — `git add src/lib/split-message.ts && git commit -m "feat: split — teto default 550→350 pra bolhas mais curtas (backstop)"`

---

### Task 3: Prompt v16 — proatividade (acolhe E continua)

**Files:**
- Modify: `src/lib/default-prompt.ts`

- [ ] **Step 1: Reforçar "TODA resposta termina puxando"** — substituir o primeiro bullet do PIPELINE:

`- TODA resposta sua termina engatando a PRÓXIMA etapa pendente do funil com uma pergunta leve — nunca deixe a conversa sem próximo passo. Ex.: informou os valores (2) e já sabe a modalidade? Emende na mesma resposta: "Como posso te chamar?" (3). Acolheu a queixa (4)? Emende: "Quais dias e horários costumam ser melhores pra você?" (5).`

por:

`- TODA resposta sua termina engatando a PRÓXIMA etapa pendente do funil com uma pergunta leve (na ÚLTIMA bolha) — NUNCA pare a conversa, nem depois de passar os valores, nem depois de acolher. Não fique esperando o paciente dizer "ok" pra continuar: VOCÊ conduz. Ex.: informou os valores (2)? Emende, numa bolha seguinte: "Como posso te chamar?" (3). Acolheu a queixa (4)? Emende: "Quais dias e horários costumam ser melhores pra você?" (5).`

- [ ] **Step 2: Corrigir a "exceção de ritmo" (acolher NÃO é parar)** — substituir:

`- Exceção de ritmo: se a pessoa acabou de compartilhar uma dor, acolha PRIMEIRO (sem pergunta comercial colada na mesma frase); a pergunta da próxima etapa vem numa bolha separada ou no turno seguinte.`

por:

`- Exceção de ritmo (acolher NÃO é parar): se a pessoa compartilhou uma dor, acolha PRIMEIRO numa bolha (sem pergunta comercial colada na mesma frase) e, LOGO EM SEGUIDA, após uma LINHA EM BRANCO, puxe com delicadeza a próxima etapa — TUDO no mesmo turno. Nunca encerre só no acolhimento esperando o paciente responder. Ex.: "Sinto muito que esteja passando por isso, Murilo. É um passo importante você ter buscado ajuda 💙" [LINHA EM BRANCO] "Pra eu te ajudar a achar o melhor horário, quais dias e períodos costumam funcionar melhor pra você?"`

- [ ] **Step 3: Commit** — `git add src/lib/default-prompt.ts && git commit -m "feat: prompt v16 — proatividade: acolhe e continua no mesmo turno, nunca para"`

---

### Task 4: Prompt v16 — balões + formatação com tópicos

**Files:**
- Modify: `src/lib/default-prompt.ts`

- [ ] **Step 1: Reforçar RESPOSTAS CURTAS + tópicos** — substituir a regra atual:

`- **RESPOSTAS CURTAS**. WhatsApp é conversa: mensagens de 1 a 3 frases, no máximo ~400 caracteres. Se o assunto precisa de mais informação (ex.: explicar valores, como funciona terapia de casal), prefira mandar em 2 mensagens curtas: escreva a primeira, depois uma LINHA EM BRANCO, depois a segunda — o sistema entrega como duas bolhas separadas. No máximo 3 bolhas. Nunca despeje tudo num bloco só. Termine sempre com o próximo passo natural ou uma pergunta simples.`

por:

`- **RESPOSTAS CURTAS, EM BOLHAS**. WhatsApp é conversa: cada bolha tem 1 a 3 frases (no máx ~350 caracteres). SEMPRE que a resposta trouxer 2 ou mais informações (ex.: modalidade + valores + pagamento; ou acolhimento + próximo passo), QUEBRE em 2–3 bolhas: escreva a primeira, depois uma LINHA EM BRANCO, depois a próxima — o sistema entrega como bolhas separadas. Uma ideia por bolha, no máximo 3. Nunca despeje tudo num bloco corrido. Quando houver uma LISTA (valores, etapas da terapia de casal, opções, o que trazer), organize em tópicos curtos — um item por linha, com "•" ou um emoji — pra facilitar a leitura aos olhos; mas mantenha o acolhimento e a conversa em prosa natural, nunca vire um formulário. Termine SEMPRE com o próximo passo natural ou uma pergunta simples.`

- [ ] **Step 2: Reescrever "COMO APRESENTAR A INFORMAÇÃO INICIAL"** — substituir o bloco inteiro:

```
COMO APRESENTAR A INFORMAÇÃO INICIAL (quando for passar os valores, dê o pacote completo, no estilo natural do WhatsApp — 1 a 2 bolhas curtas):
- Junte sempre MODALIDADE + DURAÇÃO + VALORES + PAGAMENTO numa fala fluida. Individual: "As sessões são online, por chamada de vídeo, com duração de 45 minutos. A avulsa é R$ 75,00 e o pacote mensal (4 sessões, 1 por semana) sai por R$ 280,00, com desconto. O pagamento é via Pix." Casal: mesma estrutura com 50 min, avulsa R$ 150,00 e pacote R$ 550,00.
- Mencione SÓ Pix como pagamento (o comprovante Pix é o que confirma). Se a pessoa perguntar de cartão, diga que dá pra ver com a equipe — não prometa cartão como se fechasse sozinho.
- NÃO peça o nome nessa mensagem: engate a próxima etapa do funil com leveza (o que a trouxe à terapia, ou "quer que eu já veja um horário pra você?").
```

por:

```
COMO APRESENTAR A INFORMAÇÃO INICIAL (quando for passar os valores): NUNCA num bloco só — quebre em 2 a 3 bolhas, com uma LINHA EM BRANCO entre elas, e SEMPRE termine puxando a próxima etapa. Modelo individual (cada linha em branco vira uma bolha):
"As sessões são online, por chamada de vídeo, com duração de 45 minutos 😊

A avulsa é R$ 75,00 e o pacote mensal (4 sessões, 1 por semana) sai por R$ 280,00, com desconto. O pagamento é via Pix.

Como posso te chamar?"
- Casal: mesma estrutura, com 50 min, avulsa R$ 150,00 e pacote R$ 550,00.
- Se ficar mais claro em tópicos, pode listar (um por linha): "• Online, por vídeo — 45 min / • Avulsa: R$ 75,00 / • Pacote mensal (4 sessões): R$ 280,00 / • Pagamento: via Pix" — e a próxima pergunta vai numa bolha separada depois.
- Mencione SÓ Pix (cartão só com a equipe — não prometa cartão como se fechasse sozinho). Nunca despeje tudo numa frase corrida e NUNCA termine sem a próxima pergunta (nome, ou o que a trouxe à terapia).
```

- [ ] **Step 3: Bump da versão** — trocar:

`export const PROMPT_VERSION = '2026-07-23-cazule-v15-primeiro-nome-info-inicial-formulario';`

por:

`export const PROMPT_VERSION = '2026-07-23-cazule-v16-proatividade-e-baloes';`

- [ ] **Step 4: Commit** — `git add src/lib/default-prompt.ts && git commit -m "feat: prompt v16 — info inicial em 2-3 balões, tópicos pra listas, sempre puxa o próximo passo"`

---

### Task 5: Verificação (testes + build)

**Files:** nenhum (só execução)

- [ ] **Step 1: Units puros** — `npx tsx scripts/test-split.ts && npx tsx scripts/test-comprovante-core.ts && npx tsx scripts/test-anti-repeat.ts && npx tsx scripts/test-parse-modelo.ts && npx tsx scripts/test-agenda.ts && npx tsx scripts/test-followup.ts` → todos verdes.

- [ ] **Step 2: Suíte de triagem** — `npx tsx --env-file=.env.local scripts/test-triagem.ts` → todos verdes, incluindo os 2 novos (`info inicial -> quebra em bolhas` e `acolhe a dor e CONTINUA`). Flake conhecido: `pronto` no luto/Lucas → re-rodar 1x se for a única falha.

- [ ] **Step 3: Persona passiva** — `npx tsx --env-file=.env.local scripts/sim-conversa.ts passivo` → conferir no log que as respostas agora vêm em 2–3 bolhas (linhas em branco) e que a Camila não para (emenda o próximo passo em cada turno).

- [ ] **Step 4: Build** — `pnpm build` → verde.

---

### Task 6: Deploy + docs + mensagem

**Files:**
- Modify: `CONTEXTO-CAZULE.md` (Leva 8)
- Create: `docs/superpowers/plans/2026-07-23-camila-proatividade-e-baloes.md` (cópia deste plano)
- Create/Modify: `mensagem-bruna-v15.md` → adicionar/registrar nota da v16 (ou `mensagem-bruna-v16.md`)
- Memória: `cazule-projeto.md`, `cazule-integracoes.md`, `MEMORY.md`

- [ ] **Step 1: Deploy** — `gh auth switch --user vertechsolutions && gh auth setup-git && git push origin master`; monitorar `railway deployment list --json` até o commit novo aparecer com `status: SUCCESS` (conferir o `commitHash`); então `/api/health` → 200.

- [ ] **Step 2: Teste real dirigido (Murilo, 49 99955-1051)** — repetir o fluxo do log anterior e conferir: (a) a info inicial vem em 2–3 balões e já termina puxando o nome; (b) ao dar a queixa/dor, a Camila acolhe **e continua** no mesmo turno (puxa disponibilidade), sem precisar de empurrão; (c) as mensagens densas ficam legíveis (tópicos quando cabe). Antes de testar, apagar a conversa de novo se quiser começar limpo (endpoint `DELETE /api/admin/patient?waId=554999551051` ou o DELETE direto no Postgres).

- [ ] **Step 3: Docs + memória** — Leva 8 no `CONTEXTO-CAZULE.md`; atualizar `cazule-projeto.md`, `cazule-integracoes.md` (v16) e `MEMORY.md`; copiar este plano pra `docs/superpowers/plans/`.

- [ ] **Step 4: Commit docs** — `git add` específico (CONTEXTO + plano + mensagem) e commit; push.

---

## Verificação final

- `test-split` ✔ (novo teto) · `test-triagem` verdes (2 novos: bolhas≥2 + acolhe-e-continua) · `sim-conversa passivo` mostra 2–3 bolhas e condução contínua · `pnpm build` ✔
- Deploy SUCCESS · health 200
- Real: info inicial em balões + já puxa o nome; acolhe a dor e continua no mesmo turno; listas em tópicos legíveis

## Riscos e mitigação

- **Bolhas demais / picotado**: teto de 3 bolhas (`DEFAULT_MAX_PARTS`) continua; o prompt diz "no máximo 3" e "uma ideia por bolha". O `splitReply` só quebra por frase acima de 350, então não pica saudações curtas.
- **Virar "formulário" com bullets** (tensão com o pedido da Bruna de conversa natural): a regra limita tópicos a LISTAS (valores/etapas/opções) e mantém acolhimento em prosa. Validar no `sim-conversa` que o tom segue humano.
- **maxLen 350 quebrar uma fala coerente em ponto ruim**: só afeta respostas > 350 sem `\n\n` do modelo; a quebra é por fim de frase (nunca no meio). O ideal (modelo colando `\n\n`) é reforçado pelos exemplos.
- **Proatividade virar afobação**: a exceção de ritmo continua acolhendo PRIMEIRO; a mudança é só garantir a 2ª bolha com o próximo passo, sem colar pergunta comercial na frase do acolhimento.
- **Flake do `pronto`** (luto/Lucas): conhecido, não afeta o handoff (via `enviarForm`) — re-rodar 1x se for a única falha.
