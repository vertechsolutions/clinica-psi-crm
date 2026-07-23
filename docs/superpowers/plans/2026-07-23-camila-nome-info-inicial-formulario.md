# Ajustes da Bruna — primeiro nome, informação inicial e formulário de triagem (v15)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> Ao iniciar a execução, copie este plano para `docs/superpowers/plans/2026-07-23-camila-nome-info-inicial-formulario.md`.

## Context

A Bruna (psicóloga da Clínica Cazule, interlocutora do piloto) mandou 3 ajustes a partir de prints reais de teste da Camila (assistente de WhatsApp, persona da IA):

1. **Retirar o "nome completo".** Hoje o prompt v14 pede o nome completo e insiste se vier abreviado ("Murilo M"). No print, o paciente estranha ("Pra que o nome completo"). **Decisão do Murilo:** a Camila pode pedir SÓ o primeiro nome ("como posso te chamar?"), de leve, mas NUNCA cobra o "completo" nem insiste — o nome oficial já é coletado no formulário de triagem no fim.
2. **Enriquecer a informação inicial.** A Bruna mostrou o estilo de uma clínica de referência (modalidade + valores + pagamento numa fala fluida) e quer que a mensagem inicial inclua **modalidade (online, chamada de vídeo, 45 min) + valores**. **Decisão do Murilo:** mencionar **só Pix** como pagamento (o comprovante Pix é o que confirma o agendamento; cartão não tem gateway integrado).
3. **Formulário de triagem após o pagamento.** O código **já envia** o formulário automaticamente após o comprovante válido (`enviarForm` → `{FORM_URL}` no Passo 4). O problema real: quando o paciente pergunta os próximos passos / o que é a triagem, a Camila diz "a psicóloga entrará em contato" mas **nunca menciona que um formulário de triagem será enviado pra preenchimento**. É preciso fazer a Camila mencionar o formulário na explicação e na mensagem de confirmação.

**Outcome esperado:** a Camila para de cobrar nome completo (aceita o primeiro nome ou o abreviado), abre com uma informação inicial completa no estilo da referência (modalidade + valores + Pix), e sempre deixa claro que o formulário de triagem é enviado após o comprovante.

## Architecture

Mudança quase inteiramente de **redação de prompt** — `src/lib/default-prompt.ts` (o system prompt da Camila, um template string) — mais um ajuste de uma linha na guia de extração do `triagem.ts` e a atualização dos cenários de regressão do `scripts/test-triagem.ts`. **Nenhuma mudança de código de fluxo:** o envio do formulário (`route.ts` → `computeReply` → `enviarForm`) e o alerta de handoff (`notifyTeam`, que já cai pra `nome` do perfil ou `(sem nome)`) continuam intactos. O bump de `PROMPT_VERSION` (v14 → v15) faz o assistant-store descartar o prompt antigo salvo.

## Tech Stack

TypeScript; prompt como template literal; testes `tsx` + `node:assert` com Gemini real (`--env-file=.env.local`). Deploy Railway no push pra `master` (watchPatterns incluem `src/**`).

---

### Task 1: Cenários de regressão primeiro (TDD — red)

**Files:**
- Modify: `scripts/test-triagem.ts` (cenário existente em ~275-285 + 2 novos ao final do array `CENARIOS`, antes do `];` da linha ~324)

O cenário atual "nome incompleto -> pede o nome completo uma vez e segue" agora contradiz a regra nova (não cobramos mais o completo). Reescrever + adicionar cobertura pros pedidos 2 e 3.

- [ ] **Step 1: Reescrever o cenário do nome** — substituir o bloco atual (linhas ~275-285):

```ts
  {
    nome: 'nome incompleto -> pede o nome completo uma vez e segue',
    falas: ['oi, quero agendar uma sessao individual', 'meu nome é Murilo M', 'Murilo Martins Nunes'],
    checar: (t) => {
      const aposIncompleto = t[1].res.resposta;
      const pediu = /nome complet/i.test(aposIncompleto);
      const nomeFinal = t[t.length - 1].res.lead.nome || '';
      const capturou = /martins/i.test(nomeFinal);
      return { ok: pediu && capturou, nota: `pediuCompleto=${pediu} nomeFinal="${nomeFinal}"` };
    },
  },
```

por:

```ts
  {
    nome: 'nome abreviado -> aceita sem cobrar o completo',
    falas: ['oi, quero agendar uma sessao individual', 'meu nome é Murilo M', 'ando com muita ansiedade no trabalho'],
    checar: (t) => {
      const aposNome = t[1].res.resposta;
      const naoCobrou = !/nome complet|completinho/i.test(aposNome);
      const nomeFinal = t[t.length - 1].res.lead.nome || '';
      const capturou = /murilo/i.test(nomeFinal);
      return { ok: naoCobrou && capturou, nota: `naoCobrouCompleto=${naoCobrou} nomeFinal="${nomeFinal}"` };
    },
  },
```

- [ ] **Step 2: Adicionar 2 cenários novos** — inserir logo antes do `];` que fecha `CENARIOS` (após o cenário 'comprovante com CHAVE errada'):

```ts
  {
    nome: 'pergunta preço -> informação inicial traz modalidade + valores',
    falas: ['oi, quanto custa a sessão?'],
    checar: (t) => {
      const r = ultimo(t).resposta.toLowerCase();
      const temModalidade = /online|v[íi]deo|45\s?min|45 minutos/.test(r);
      const temValor = /75|280/.test(r);
      const temPix = /pix/.test(r);
      return {
        ok: temModalidade && temValor,
        nota: `modalidade=${temModalidade} valor=${temValor} pix=${temPix} | "${ultimo(t).resposta.slice(0, 160)}"`,
      };
    },
  },
  {
    nome: 'pergunta próximos passos -> menciona o formulário de triagem',
    falas: ['oi, quero agendar uma sessao individual', 'depois que eu pagar, quais são os próximos passos?'],
    checar: (t) => {
      const r = ultimo(t).resposta.toLowerCase();
      const mencionaFormulario = /formul[áa]rio/.test(r);
      return { ok: mencionaFormulario, nota: `mencionaFormulario=${mencionaFormulario} | "${ultimo(t).resposta.slice(0, 160)}"` };
    },
  },
```

- [ ] **Step 3: Rodar e ver os afetados falharem** — `npx tsx --env-file=.env.local scripts/test-triagem.ts`

Esperado: o cenário `nome abreviado` FALHA (v14 ainda cobra "nome completo") e `pergunta próximos passos` FALHA (v14 não menciona formulário). O de `preço` pode passar parcialmente. (Protocolo de flake: campos null / erro de rede Gemini → re-rodar 1x.)

- [ ] **Step 4: Commit** — `git add scripts/test-triagem.ts && git commit -m "test: nome abreviado (sem cobrar completo) + info inicial + próximos passos mencionam formulário"`

---

### Task 2: Prompt v15 — pedido 1 (só primeiro nome)

**Files:**
- Modify: `src/lib/default-prompt.ts`
- Modify: `src/lib/triagem.ts`

- [ ] **Step 1: Ajustar exemplos da regra "UMA coisa de cada vez" (linha ~13)** — trocar:

`- UMA coisa de cada vez. ... exemplos do que NÃO fazer: "me diz seu nome completo e o que te motivou a buscar terapia?" ou "qual seu nome completo? E quais dias e horários são bons para você?". Peça primeiro SÓ o nome; motivação e disponibilidade vêm nos turnos seguintes, um de cada vez.`

por (só as partes destacadas mudam — "nome completo" → "nome", "SÓ o nome" → "SÓ o primeiro nome"):

`- UMA coisa de cada vez. ... exemplos do que NÃO fazer: "me diz seu nome e o que te motivou a buscar terapia?" ou "qual seu nome? E quais dias e horários são bons para você?". Peça primeiro SÓ o primeiro nome; motivação e disponibilidade vêm nos turnos seguintes, um de cada vez.`

- [ ] **Step 2: Reescrever a coleta do nome (linha ~97)** — substituir:

`- Nome completo. Se a pessoa der um nome que parece incompleto (uma palavra só, ex. "Murilo", ou com abreviação/inicial, ex. "Murilo M"), agradeça e peça UMA vez, com leveza, o nome completo ("pode me passar seu nome completinho? É pra ficha da psicóloga 😊"). Se ela não completar, siga o fluxo normalmente com o que deu — nunca trave a conversa por causa disso.`

por:

`- Primeiro nome, só pra saber como chamar a pessoa. Pergunte de leve UMA vez ("como posso te chamar?") ou use o nome que ela já tiver dito / que veio do WhatsApp. NUNCA peça o nome "completo" e NUNCA insista se vier abreviado ("Murilo" ou "Murilo M" já está ótimo) — o nome oficial é coletado no formulário de triagem no fim. Nunca trave a conversa por causa do nome.`

- [ ] **Step 3: Atualizar a etapa 3 do PIPELINE (linha ~106)** — trocar `(3) nome` por `(3) primeiro nome (leve, sem cobrar completo)` na frase "As etapas do funil são: (1) modalidade → (2) valores → (3) nome → ...".

- [ ] **Step 4: Atualizar o exemplo do PIPELINE (linha ~107)** — trocar `Emende na mesma resposta: "Qual seu nome completo, por gentileza?" (3).` por `Emende na mesma resposta: "Como posso te chamar?" (3).`

- [ ] **Step 5: Ajustar a guia de extração (triagem.ts, linha ~15)** — em `src/lib/triagem.ts`, trocar `  - "nome": nome completo da pessoa.` por `  - "nome": o nome da pessoa como ela se apresentou (primeiro nome basta — não precisa ser completo).`

- [ ] **Step 6: Commit** — `git add src/lib/default-prompt.ts src/lib/triagem.ts && git commit -m "feat: prompt v15 — Camila pede só o primeiro nome, nunca cobra o completo"`

---

### Task 3: Prompt v15 — pedido 2 (informação inicial: modalidade + valores + Pix)

**Files:**
- Modify: `src/lib/default-prompt.ts`

- [ ] **Step 1: Enriquecer a regra de abertura sobre preço (linha ~20)** — na frase que começa "Adapte-se ao que a pessoa traz.", trocar:

`... quando ela não disse se é individual ou casal, JÁ informe o valor individual (avulsa R$ 75, pacote mensal R$ 280) e mencione que casal tem outro valor — NUNCA segure o preço atrás da pergunta "individual ou casal?".`

por:

`... quando ela não disse se é individual ou casal, JÁ informe o pacote individual (sessão online por chamada de vídeo, 45 min; avulsa R$ 75, pacote mensal R$ 280; pagamento via Pix) e mencione que casal tem outro valor — NUNCA segure o preço atrás da pergunta "individual ou casal?".`

- [ ] **Step 2: Deixar Pix como forma padrão nas duas fichas de valores (linhas ~46 e ~52)** — substituir AMBAS as ocorrências de `- Pagamento: Pix ou cartão de crédito.` por `- Pagamento: via Pix (é o que confirma o agendamento). Cartão de crédito só com a equipe — não ofereça cartão como pagamento automático.` (use replace_all, o texto é idêntico nas duas).

- [ ] **Step 3: Adicionar a diretriz de INFORMAÇÃO INICIAL** — inserir um bloco novo logo após a ficha "VALORES E FORMATO — CASAL" (após a linha "- Pagamento..." do casal, antes de "ABORDAGENS DISPONÍVEIS:"):

```
COMO APRESENTAR A INFORMAÇÃO INICIAL (quando for passar os valores, dê o pacote completo, no estilo natural do WhatsApp — 1 a 2 bolhas curtas):
- Junte sempre MODALIDADE + DURAÇÃO + VALORES + PAGAMENTO numa fala fluida. Individual: "As sessões são online, por chamada de vídeo, com duração de 45 minutos. A avulsa é R$ 75,00 e o pacote mensal (4 sessões, 1 por semana) sai por R$ 280,00, com desconto. O pagamento é via Pix." Casal: mesma estrutura com 50 min, avulsa R$ 150,00 e pacote R$ 550,00.
- Mencione SÓ Pix como pagamento (o comprovante Pix é o que confirma). Se a pessoa perguntar de cartão, diga que dá pra ver com a equipe — não prometa cartão como se fechasse sozinho.
- NÃO peça o nome nessa mensagem: engate a próxima etapa do funil com leveza (o que a trouxe à terapia, ou "quer que eu já veja um horário pra você?").
```

- [ ] **Step 4: Enriquecer a dúvida clássica "Quanto custa?" (linha ~63)** — substituir:

`  → JÁ informe o valor individual, sem segurar atrás de pergunta: sessão de 45min — avulsa R$ 75,00 ou pacote mensal R$ 280,00 (4 sessões). Diga que casal tem valor diferente e pergunte de leve se é individual ou casal. NUNCA responda só "você busca individual ou casal?" sem dar o valor. Prefira 2 bolhas: a primeira com os valores, linha em branco, a segunda perguntando de leve se é individual ou casal.`

por:

`  → JÁ informe o pacote individual, sem segurar atrás de pergunta: sessões online por chamada de vídeo, de 45min — avulsa R$ 75,00 ou pacote mensal R$ 280,00 (4 sessões, 1 por semana), pagamento via Pix. Diga que casal tem valor diferente e pergunte de leve se é individual ou casal. NUNCA responda só "você busca individual ou casal?" sem dar o valor. Prefira 2 bolhas: a primeira com modalidade + valores, linha em branco, a segunda perguntando de leve se é individual ou casal.`

- [ ] **Step 5: Commit** — `git add src/lib/default-prompt.ts && git commit -m "feat: prompt v15 — informação inicial com modalidade + valores + Pix (estilo da referência)"`

---

### Task 4: Prompt v15 — pedido 3 (formulário de triagem visível na conversa)

**Files:**
- Modify: `src/lib/default-prompt.ts`

- [ ] **Step 1: Nova dúvida clássica sobre próximos passos / triagem** — inserir logo após a dúvida "Emitem declaração de comparecimento?" (antes de "O QUE VOCÊ REÚNE AO LONGO DA CONVERSA"):

```
- "Quais os próximos passos? / O que acontece depois que eu pagar? / Como funciona a triagem?"
  → Explique o caminho SEM omitir o formulário: assim que você confirma o pagamento (envio do comprovante), eu te envio um formulário de triagem pra você preencher — é por ele que a psicóloga conhece um pouco da sua história antes da primeira conversa. Depois disso ela entra em contato por aqui pelo WhatsApp pra dar início. Se a pessoa ainda não pagou, deixe claro que o formulário vem DEPOIS do comprovante (nunca antes).
```

- [ ] **Step 2: Fazer a confirmação do Passo 4 mencionar o formulário (linha ~131)** — substituir a mensagem exata:

`- Confirme com essa mensagem exata: "Confirmação realizada! A triagem será enviada e a psicóloga entrará em contato pelo WhatsApp. Esse é o nosso canal de atendimento, então sempre que precisar pode nos chamar por aqui. Caso você não se identifique com a profissional, podemos fazer o remanejamento para outra psicóloga, é só nos avisar."`

por:

`- Confirme com essa mensagem exata: "Confirmação realizada! Vou te enviar agora um formulário de triagem pra você preencher — é por ele que a psicóloga recebe sua história antes da primeira conversa. Depois disso ela entra em contato por aqui pelo WhatsApp. Esse é o nosso canal de atendimento, então sempre que precisar pode nos chamar por aqui. Caso você não se identifique com a profissional, podemos fazer o remanejamento para outra psicóloga, é só nos avisar."`

(A mensagem do link do formulário — linha ~132, "Este é o nosso formulário, solicito que seja preenchido..." — já é o "textinho padrão" e continua sendo enviada em seguida com `enviarForm=true`. Sem mudança.)

- [ ] **Step 3: Bump da versão (linha ~155)** — trocar:

`export const PROMPT_VERSION = '2026-07-20-cazule-v14-nome-completo-comprovante-lido';`

por:

`export const PROMPT_VERSION = '2026-07-23-cazule-v15-primeiro-nome-info-inicial-formulario';`

- [ ] **Step 4: Commit** — `git add src/lib/default-prompt.ts && git commit -m "feat: prompt v15 — Camila menciona o formulário de triagem nos próximos passos e na confirmação"`

---

### Task 5: Verificação — testes verdes + build (green)

**Files:** nenhum (só execução)

- [ ] **Step 1: Units puros** — `npx tsx scripts/test-comprovante-core.ts && npx tsx scripts/test-anti-repeat.ts && npx tsx scripts/test-parse-modelo.ts && npx tsx scripts/test-split.ts && npx tsx scripts/test-agenda.ts && npx tsx scripts/test-followup.ts` → todos verdes (garante que nada quebrou).

- [ ] **Step 2: Suíte de triagem** — `npx tsx --env-file=.env.local scripts/test-triagem.ts` → todos os cenários verdes, incluindo `nome abreviado`, `pergunta preço` e `pergunta próximos passos`. Protocolo de flake: falha isolada com campos null / erro de rede Gemini → re-rodar 1x. O cenário `comprovante em imagem` (fluxo feliz) NÃO pode ter regredido.

- [ ] **Step 3: Persona passiva fecha o funil** — `npx tsx --env-file=.env.local scripts/sim-conversa.ts passivo` → o funil fecha até o handoff SEM cobrar nome completo e mencionando o formulário no fim.

- [ ] **Step 4: Build** — `pnpm build` → verde.

---

### Task 6: Deploy + docs + mensagem pra Bruna

**Files:**
- Modify: `CONTEXTO-CAZULE.md` (seção Leva 7)
- Create: `docs/superpowers/plans/2026-07-23-camila-nome-info-inicial-formulario.md` (cópia deste plano)
- Create: `mensagem-bruna-v15.md` (resposta formatada pra Bruna)
- Memória: `cazule-projeto.md`, `cazule-integracoes.md`, `MEMORY.md`

- [ ] **Step 1: Deploy** — push com a conta certa e monitorar:

```bash
gh auth switch --user vertechsolutions && gh auth setup-git && git push origin master
```

Depois `railway deployment list` até o commit novo aparecer como SUCCESS; então checar o `/api/health` → 200. (Rede local instável: se o push falhar com "Connection reset"/"Empty reply", re-tentar após alguns segundos e conferir `git status` — costuma ter subido na 1ª tentativa.)

- [ ] **Step 2: Teste real dirigido (Murilo, 49999551051)** — no WhatsApp real:
  - (a) mandar "oi, quanto custa?" → a informação inicial vem com **modalidade (online/vídeo/45min) + valores + Pix**;
  - (b) dar o nome como "Murilo M" → a Camila **aceita e segue**, sem pedir o completo;
  - (c) perguntar "quais os próximos passos depois de pagar?" → a resposta **menciona o formulário de triagem**;
  - (d) fluxo até o Pix + comprovante correto → confirmação **mencionando o formulário** + envio do link + alerta de handoff pra Bruna.

- [ ] **Step 3: Docs + memória** — Leva 7 no `CONTEXTO-CAZULE.md`; atualizar `cazule-projeto.md` e `cazule-integracoes.md` (estado v15, prompt `2026-07-23-cazule-v15-primeiro-nome-info-inicial-formulario`) e a linha do índice em `MEMORY.md`; copiar este plano pra `docs/superpowers/plans/`. Escrever `mensagem-bruna-v15.md` (formato WhatsApp) confirmando os 3 ajustes.

- [ ] **Step 4: Commit docs** — `git add -A && git commit -m "docs: Leva 7 — primeiro nome, informação inicial e formulário de triagem (v15)"` e push (docs não redeploya, tudo bem).

---

## Verificação final

- Units puros ✔ · `test-triagem` todos verdes (reescrito `nome abreviado` + 2 novos) · `sim-conversa passivo` fecha o funil · `pnpm build` verde
- Deploy SUCCESS · health 200
- Real: (a) info inicial com modalidade + valores + Pix; (b) "Murilo M" aceito sem cobrar completo; (c/d) formulário de triagem mencionado nos próximos passos e na confirmação

## Riscos e mitigação

- **Nome sumir do alerta de handoff:** `notifyTeam` já cai pra `nome` do perfil WhatsApp e, no pior caso, `(sem nome)`; o nome oficial vem do formulário. Como ainda pedimos o primeiro nome de leve, na prática o alerta segue com nome. Sem mudança de código necessária.
- **Camila oferecer cartão e travar o funil:** a diretriz de informação inicial e as fichas de valores passam a dizer "só Pix / cartão só com a equipe", evitando prometer um caminho que a automação não fecha.
- **Flakiness dos cenários com Gemini:** o assert de `pix` no cenário de preço é reportado mas NÃO bloqueia (só modalidade + valor são obrigatórios), pra não falhar por variação de fraseado. Protocolo de flake: re-rodar 1x.
- **Regressão do fluxo feliz:** o cenário `comprovante em imagem` e a persona passiva cobrem o caminho até o handoff — rodar ambos antes do deploy.
