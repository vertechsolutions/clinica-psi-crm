# Leva 12 — Debounce, sem emoji e anti-bot (plano de implementação)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) ou superpowers:executing-plans para implementar tarefa a tarefa. Os passos usam checkbox (`- [ ]`).

**Goal:** o lead que manda várias mensagens seguidas recebe **uma** resposta que considera todas elas; nenhuma mensagem que chega ao paciente tem emoji; e um bot do outro lado é detectado, silenciado e reportado à equipe em vez de conversar em loop.

**Architecture:** o webhook deixa de responder por mensagem e passa a responder por **turno**. Um buffer em memória por `wa_id` agenda o turno para 8s de silêncio (cancelável: cada mensagem nova reinicia), e um **claim otimista com TTL** no Postgres garante que dois turnos concorrentes nunca respondam os dois — sem segurar conexão do pool, ao contrário do advisory lock que o brief propunha. O `computeReply` já lê o histórico inteiro do banco, então agregar as mensagens da rajada sai de graça. O filtro de emoji é determinístico e aplicado nos **cinco** pontos de saída (o `bolhasDoTurno` não cobre todos). A detecção de bot é um módulo puro que agrupa mensagens consecutivas em turnos lógicos antes de comparar — sem isso, uma rajada de três "oi" dispararia falso positivo na primeira interação.

**Tech Stack:** Next.js 16.2.7 (App Router), TypeScript, Postgres (`pg` cru, sem ORM), Google Gemini (`@google/genai`), scripts de teste com `npx tsx` e `node:assert`.

**Spec:** `docs/superpowers/specs/2026-08-07-camila-debounce-emoji-antibot-design.md`
**Brief:** `docs/superpowers/specs/2026-08-07-camila-debounce-emoji-antibot-brief.md`

**Origem:** três pedidas da Bruna em 06/08/2026, com print do número `+55 49 9973-7313` mostrando a Camila respondendo o mesmo par de bolhas duas vezes às 17:59.

**Regra do projeto (AGENTS.md):** "This is NOT the Next.js you know". Antes de tocar `route.ts` ou `instrumentation.ts`, leia o guia relevante em `node_modules/next/dist/docs/`.

---

### Task 1: Prefactor — allowlist extraída e loadHistory exportado

Make the change easy, then make the easy change. Nenhum comportamento muda; isto destrava as Tasks 4 e 6.

**Fecha:** CA9 (nada regride) · **Blocked by:** nenhuma

**Files:**
- Create: `src/lib/allowlist.ts`
- Modify: `src/app/api/whatsapp/webhook/route.ts`, `src/lib/conversation.ts`

- [x] **Step 1: Ler a doc do Next antes de tocar o route**

Ler o guia de rotas em `node_modules/next/dist/docs/` — esta versão tem convenções próprias sobre o que um `route.ts` pode exportar além dos handlers. É a razão de a allowlist sair de lá.

- [x] **Step 2: Extrair a allowlist**

Mover `allowlist()` e `atende()` de `route.ts:81-91` para `src/lib/allowlist.ts`, sem mudar uma linha da lógica. O `route.ts` passa a importar. Motivo: a varredura de boot (Task 6) precisa do mesmo gate, e ele não pode viver num handler HTTP.

- [x] **Step 3: Exportar loadHistory**

Acrescentar `export` a `loadHistory` em `src/lib/conversation.ts:77`. Sem mudança de assinatura. O `computeReply` continua chamando internamente.

- [x] **Step 4: Provar que nada mudou**

`npm test` verde. `npm run test:webhook` verde — os cenários de allowlist, eco, pausa, legado e dedup precisam passar idênticos.

---

### Task 2: Sem emoji nas mensagens do paciente

Fecha a segunda pedida da Bruna por inteiro. Independente do resto — pode virar PR próprio.

**Fecha:** CA3, CA10 · **Blocked by:** Task 1

**Files:**
- Create: `src/lib/emoji.ts`, `scripts/test-emoji.ts`, `scripts/sync-prompt.ts`
- Modify: `src/lib/fechamento.ts`, `src/lib/followup.ts`, `src/lib/default-prompt.ts`, `src/app/api/whatsapp/webhook/route.ts`, `scripts/test-all.ts`

- [x] **Step 1: Escrever o teste que falha**

Criar `scripts/test-emoji.ts` no padrão do repo (`import assert from 'node:assert'`, asserções com mensagem, `console.log` no fim). Casos obrigatórios:

```ts
// preserva o que NÃO é emoji
assert.equal(semEmoji('R$ 180,00'), 'R$ 180,00');              // \p{Emoji} casaria os dígitos
assert.equal(semEmoji('sessão à distância, é ótimo'), 'sessão à distância, é ótimo');
assert.equal(semEmoji('• primeiro item'), '• primeiro item');
assert.equal(semEmoji('#1 e *asterisco*'), '#1 e *asterisco*');

// remove emoji e modificadores
assert.equal(semEmoji('Olá! 😊'), 'Olá!');
assert.equal(semEmoji('família 👨‍👩‍👧‍👦 toda'), 'família toda');   // ZWJ inteiro
assert.equal(semEmoji('joia 👍🏽'), 'joia');                       // skin tone
assert.equal(semEmoji('5️⃣ sessões'), '5 sessões');               // keycap vira o dígito
assert.equal(semEmoji('atenção ⚠️ aqui'), 'atenção aqui');       // variation selector

// espaço órfão colapsa, mas a quebra dupla (separador de bolha) sobrevive
assert.equal(semEmoji('bom 😊 dia'), 'bom dia');
assert.equal(semEmoji('linha um 😊\n\nlinha dois'), 'linha um\n\nlinha dois');
```

Rodar e ver falhar.

- [x] **Step 2: Implementar o filtro**

Criar `src/lib/emoji.ts` com `semEmoji(texto: string): string`.

```ts
const EMOJI_CHAR = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}‍️⃣]/gu;
```

**Proibido `\p{Emoji}`** — ele casa `0-9`, `#` e `*`, e destruiria preço e lista numerada. O dígito base do keycap não está na classe, só a marca combinante `U+20E3`, então `5️⃣` vira `5`.

Pós-processamento, nesta ordem: remover a classe, tirar espaço antes e depois de quebra de linha, colapsar espaços múltiplos, `trim()`. **Não pode tocar `\n\n`** — é o separador de bolha do `splitReply`.

- [x] **Step 3: Plugar nos cinco pontos de saída**

O `bolhasDoTurno` **não cobre tudo**. Aplicar em todos:

1. `src/lib/fechamento.ts:41` — `.map(semEmoji)` no array retornado por `bolhasDoTurno` (cobre resposta do modelo e as 4 bolhas oficiais).
2. `route.ts:44` `PEDE_TEXTO` — no call site: `sendText(from, semEmoji(fallback))`.
3. `route.ts:46` `PEDE_TEXTO_OUTRAS_MIDIAS` — mesmo call site.
4. `route.ts:48/54` `FALHA_TEMPORARIA`/`sendFallback` — mesmo tratamento (hoje já está limpo; é defesa contra edição futura).
5. `src/lib/followup.ts:125` `MENSAGEM_RETENCAO` — **o que o brief não viu**: sai pelo cron de 1h, direto por `sendText`, fora do fluxo do webhook inteiro.

Não precisam: `comprovante-core.ts:116` (o `⚠️` está no marcador gravado em `wa_messages` para realimentar o Gemini, não vai ao lead) e `mensagemAnexoInvalido` (vira `turno.resposta` e já passa pelo ponto 1).

- [x] **Step 4: Limpar o prompt**

Em `src/lib/default-prompt.ts`: linha 12 (a instrução `com "•" ou um emoji` vira só o bullet — é ela que **manda** o modelo usar emoji), e os exemplos das linhas 33, 56, 124, 158. **Não tocar a linha 14** — o `👍` ali é exemplo do que o *paciente* manda. Bump do `PROMPT_VERSION` (linha 168) para `2026-08-07-cazule-v19-sem-emoji`.

- [x] **Step 5: Script de sincronização do prompt**

Criar `scripts/sync-prompt.ts`: lê `app_config.system_prompt`, mostra um diff resumido contra o `DEFAULT_PROMPT` e grava mediante confirmação por argumento explícito (`--write`). Sem `--write`, só reporta. Motivo: o prompt do banco **vence** o do código (`conversation.ts:16-27`), então sem isto a limpeza não chega à produção. O Murilo roda manualmente contra `DATABASE_PUBLIC_URL`.

- [x] **Step 6: Registrar e verificar**

Acrescentar `test-emoji` ao array `PUROS` de `scripts/test-all.ts`. `npm test` verde.

---

### Task 3: Claim de turno no Postgres

A serialização que garante que dois turnos concorrentes nunca respondam os dois. Verificável sem Gemini e sem HTTP.

**Fecha:** CA5 · **Blocked by:** nenhuma (pode correr em paralelo com a Task 2)

**Files:**
- Create: `src/lib/turno-claim.ts`, `scripts/test-claim-live.ts`
- Modify: `src/lib/schema.ts`

- [x] **Step 1: Escrever o teste que falha**

Criar `scripts/test-claim-live.ts` (precisa de banco — **fora** do array `PUROS`). Casos:

- Dois `claimTurno` concorrentes (`Promise.all`) para um `wa_id` **novo, sem linha em `wa_conversations`**: exatamente um retorna `ok: true`. Este é o caso da print — lead de primeiro contato.
- Dois `claimTurno` concorrentes para `wa_id` já existente: idem.
- `releaseTurno` com token errado não libera; com o token certo, libera e um novo claim passa.
- `aindaTitular` retorna `false` depois que outro turno reivindicou.
- Claim expirado por TTL é reivindicável.

- [x] **Step 2: Colunas novas**

Em `src/lib/schema.ts`, novo bloco no padrão idempotente e cumulativo do arquivo:

```sql
ALTER TABLE wa_conversations
  ADD COLUMN IF NOT EXISTS turno_ate   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS turno_token TEXT;
```

- [x] **Step 3: Implementar o claim**

Criar `src/lib/turno-claim.ts` com `claimTurno(waId)`, `releaseTurno(waId, token)` e `aindaTitular(waId, token)`. `TURNO_TTL_SEGUNDOS = 90` como constante em código (teto de segurança, não parâmetro de negócio).

```sql
INSERT INTO wa_conversations (wa_id, turno_ate, turno_token)
VALUES ($1, now() + make_interval(secs => $2), $3)
ON CONFLICT (wa_id) DO UPDATE
  SET turno_ate = now() + make_interval(secs => $2), turno_token = EXCLUDED.turno_token
WHERE wa_conversations.turno_ate IS NULL OR wa_conversations.turno_ate < now()
RETURNING wa_id
```

`INSERT ... ON CONFLICT`, não `UPDATE`: a linha em `wa_conversations` **só nasce no `persistReply`**, então um `UPDATE` puro nunca pegaria o primeiro contato. Sob READ COMMITTED o segundo concorrente bloqueia no row lock e reavalia o predicado contra a versão commitada — mesma garantia que o `ON CONFLICT (wamid) DO NOTHING RETURNING id` do `recordUserMessage` já usa em produção.

Usar `query()` do pool. **Nunca `pool.connect()`** — segurar um client durante o turno esgotaria o pool de 10 conexões.

`releaseTurno` só zera se o token bater (evita apagar um claim mais novo se este processo ficou pendurado além do TTL). Best-effort, nunca lança.

- [x] **Step 4: Verificar**

`npx tsx scripts/test-claim-live.ts` contra o banco de teste. `npm test` continua verde.

---

### Task 4: Debounce ponta a ponta — uma resposta por turno

O coração da leva. Fecha a pedida da print.

**Fecha:** CA1, CA2, CA6, CA7, CA9 · **Blocked by:** Tasks 1 e 3

**Files:**
- Create: `src/lib/turno.ts`, `scripts/test-turno-concorrencia.ts`
- Modify: `src/app/api/whatsapp/webhook/route.ts`, `package.json`

- [x] **Step 1: Ler a doc do Next**

`node_modules/next/dist/docs/` — especialmente o guia de `after()`. O turno passa a rodar num timer **fora** do closure do `after()`, e é preciso confirmar o que sobrevive ao fim da request nesta versão.

- [x] **Step 2: Escrever o teste que falha**

Criar `scripts/test-turno-concorrencia.ts` no arcabouço do `test-webhook-http.ts` (que sobe o app real e tem helpers `post`/`espera`/`contar`). **Não existe nenhum teste concorrente no repo hoje** — este é o primeiro. Roda com `DEBOUNCE_MS=500` para não custar 8s por cenário. Opt-in (precisa `GEMINI_API_KEY`), fora do `PUROS`, novo script `test:turno` no `package.json`.

Cenários:
- `Promise.all` de dois POST com textos diferentes para o mesmo `wa_id`: **um** envio, **uma** chamada ao Gemini, e a resposta contempla o conteúdo das duas (CA1, CA2).
- Mensagem que chega enquanto o turno roda é respondida num ciclo seguinte, nunca descartada (CA6).
- Os cenários existentes do `test-webhook-http` seguem idênticos (CA9).

- [x] **Step 3: Implementar o turno**

Criar `src/lib/turno.ts`:

- `debounceMs()` — lê `process.env.DEBOUNCE_MS` **a cada chamada**, não em cache de módulo (é o que permite o teste setar 500 no processo filho). Default 8000.
- `registrarMensagemDoTurno({ waId, nome?, comprovante? })` — acumula no buffer (o último não-nulo de `nome` e `comprovante` vence) e reagenda cancelando o timer pendente. Nunca lança.
- `processarTurnoPendente(waId, nome?)` — porta de entrada da varredura de boot (Task 6).
- `processarTurno` (privado) — a sequência: `claimTurno` → se falhou, **reagenda** outro ciclo via `registrarMensagemDoTurno` até `MAX_TENTATIVAS_CLAIM = 3` (desistir em silêncio perderia a mensagem para sempre; nada mais a reprocessaria fora do boot) → `loadHistory` → `computeReply` em try/catch → backstop de comprovante (usa o `comprovante` do buffer) → `bolhasDoTurno(...).map(semEmoji)` → **`aindaTitular` antes de enviar** (se o token não bate mais, aborta em silêncio em vez de duplicar) → `sendTextSequence` → `persistReply` com o texto **já filtrado** → se `enviarForm`: `pauseConversation` + `notifyTeam` → `finally`: `releaseTurno`.

Migram de `route.ts` para cá: `notifyTeam`, `linhaComprovante`, `alertRecipients`, `sendFallback`, `FALHA_TEMPORARIA` — são o desfecho do turno, não roteação HTTP.

- [x] **Step 4: Cortar o webhook**

Em `route.ts`, o `after()` passa a terminar em `registrarMensagemDoTurno`. O que continua **por mensagem, imediato**: legado → pausa → `extractText` → caminho de mídia não tratada → `recordUserMessage` (dedup por `wamid`) → retorno se pausada → `markReadAndType`.

Três coisas que **não** mudam, de propósito:
- `markReadAndType` fica por mensagem. Na Z-API ele só marca lida (o "digitando" viaja no `delayTyping` do envio); na Meta o indicador expira em 25s e chamar de novo apenas o renova.
- O fallback de mídia não tratada continua **fora** do buffer — nunca chamou o modelo, nunca teve duplicação, e bufferizar acoplaria dois caminhos hoje independentes.
- A espera de 2s do `tratarEco` (`route.ts:178-180`) serve a outro propósito e **não** deve ser reaproveitada.

- [x] **Step 5: Verificar**

`npm test` verde. `npm run test:webhook` verde. `npm run test:turno` verde.

---

### Task 5: Anti-bot — três turnos idênticos calam e alertam

Fecha a terceira pedida da Bruna.

**Fecha:** CA4, CA10 · **Blocked by:** Task 4

**Files:**
- Create: `src/lib/anti-bot.ts`, `scripts/test-anti-bot.ts`
- Modify: `src/lib/turno.ts`, `scripts/test-all.ts`

- [x] **Step 1: Escrever o teste que falha**

Criar `scripts/test-anti-bot.ts` (puro). Casos obrigatórios:
- Três turnos do lead com o mesmo texto, intercalados por respostas da assistente → `true`.
- **Três mensagens idênticas na mesma rajada** (consecutivas, sem resposta entre elas) → `false`. Este é o caso do lead ansioso mandando "oi" três vezes; o debounce agrega numa só e não pode virar falso positivo.
- Dois turnos idênticos → `false` (o limiar é três).
- Textos que só diferem em maiúsculas, acento ou pontuação → contam como idênticos (a normalização é a do `anti-repeat`).
- Histórico curto demais → `false`.

- [x] **Step 2: Implementar a detecção**

Criar `src/lib/anti-bot.ts`, puro:
- `agruparPorTurno(hist)` — agrupa mensagens **consecutivas do mesmo papel** em turnos lógicos. Uma rajada debounced gera N linhas em `wa_messages` mas é **um** turno; sem isto, o falso positivo dispararia na primeira interação.
- `pareceBot(hist, n = 3)` — os últimos `n` turnos do lead são idênticos após `normalizaComparacao` (importada de `anti-repeat.ts`, sem duplicar).

Arquivo próprio, não dentro do `anti-repeat`: aquele guarda a **assistente** contra auto-repetição dentro de um turno; este avalia o **lead** ao longo de vários, com outra ação.

- [x] **Step 3: Ligar no turno**

Em `processarTurno`, **antes** do `computeReply` (não gastar Gemini num turno que vai ser silenciado): se `pareceBot`, então `pauseConversation` + `sendInternalAlert` com número, motivo e as três mensagens, e sai sem responder.

Nada a fazer no follow-up: `findColdLeads` já exclui `pausada = TRUE`, então o chat calado por bot não recebe reengajamento.

- [x] **Step 4: Registrar e verificar**

Acrescentar `test-anti-bot` ao array `PUROS`. `npm test` verde.

---

### Task 6: Varredura de pendentes no boot

Mitiga o risco que o debounce cria: restart dentro da janela de 8s engoliria a resposta. Fecha de quebra a limitação documentada em `route.ts:211-213`.

**Fecha:** CA8 · **Blocked by:** Tasks 1 e 4

**Files:**
- Create: `src/lib/boot-sweep.ts`, `scripts/test-sweep-live.ts`
- Modify: `src/instrumentation.ts`

- [x] **Step 1: Ler a doc do Next**

`node_modules/next/dist/docs/` — o guia de `instrumentation`. Precisa confirmar quantas vezes `register()` roda nesta versão e o que é seguro disparar ali.

- [x] **Step 2: Escrever o teste que falha**

Criar `scripts/test-sweep-live.ts` (precisa de banco, fora do `PUROS`). Semear linhas em `wa_messages` e assertar que `varrerPendentes()`:
- **acha** conversa cuja última mensagem `user` é mais recente que a última `assistant`, inclusive **lead novo sem linha em `wa_conversations`** (o caso mais grave: morreu antes da primeira resposta);
- **ignora** conversa pausada, número em `wa_legado`, número fora da allowlist, e mensagem com mais de 30 minutos.

- [x] **Step 3: Implementar a varredura**

Criar `src/lib/boot-sweep.ts` com `varrerPendentes(): Promise<number>`. A query parte de `wa_messages` com `LEFT JOIN wa_conversations` — partir das conversas perderia o lead novo, que ainda não tem linha:

```sql
SELECT m.wa_id, max(c.nome) AS nome
  FROM wa_messages m
  LEFT JOIN wa_conversations c ON c.wa_id = m.wa_id
 WHERE COALESCE(c.pausada, FALSE) = FALSE
 GROUP BY m.wa_id
HAVING max(m.created_at) FILTER (WHERE m.role = 'user')
       > COALESCE(max(m.created_at) FILTER (WHERE m.role = 'assistant'), '-infinity'::timestamptz)
   AND max(m.created_at) FILTER (WHERE m.role = 'user') > now() - interval '30 minutes'
```

Resetar claims presos antes (um boot novo nunca herda turno legitimamente em andamento). Por `wa_id`: revalidar `deveIgnorarPorLegado` e `atende()` — o gate tem que ser o mesmo do webhook ao vivo — e chamar `processarTurnoPendente`. **Sequencial**, para não disparar uma rajada de chamadas ao Gemini bem no health check da subida.

Limitação aceita: neste caminho não há análise de anexo fresca, então o backstop de comprovante não protege um turno que era de comprovante. O alerta de equipe já cobre com "recebido em turno anterior — conferir na conversa".

- [x] **Step 4: Ligar no boot**

Em `src/instrumentation.ts`, chamar `varrerPendentes()` depois do `initSchema`, **fire-and-forget** — não pode bloquear o boot nem atrasar o health check do Railway.

- [x] **Step 5: Verificar**

`npx tsx scripts/test-sweep-live.ts`. `npm test` verde. `npm run test:webhook` verde.

---

## Rastreabilidade

| CA | Critério | Task | Verificado por (08/08/2026) |
|---|---|---|---|
| CA1 | Dois POST concorrentes → um envio | 4 | ✅ `test:turno` — Z-API falsa conta as bolhas |
| CA2 | A resposta contempla todas as mensagens da rajada | 4 | ✅ `test:turno` — nome da 1ª msg e e-mail da 2ª na ficha extraída |
| CA3 | Zero emoji nos cinco pontos de saída; preço, acento e bullet intactos | 2 | ✅ `test-emoji` (puro) |
| CA4 | Três turnos idênticos pausam e alertam sem chamar o Gemini | 5 | ⚠️ **parcial** — `test-anti-bot` cobre o `pareceBot` puro; a **fiação** (pausar + alertar dentro do turno) não tem teste automatizado |
| CA5 | Claims concorrentes — inclusive em número novo — só um vence | 3 | ✅ `test:claim` contra Postgres real |
| CA6 | Mensagem chegada durante o turno é respondida depois, nunca descartada | 4 | ✅ `test:turno` — duas respostas, nenhuma engolida |
| CA7 | Turno que perdeu titularidade aborta o envio | 4 | ✅ `test:turno` — claim roubado por fora com o turno rodando |
| CA8 | Varredura acha lead novo pendente e respeita pausa, legado, allowlist e 30min | 6 | ✅ `test:sweep` — 7 mutações, todas pegas |
| CA9 | Cenários existentes do teste HTTP idênticos | 1, 4 | ✅ `test:webhook` |
| CA10 | Suíte pura verde com os testes novos registrados | 2, 5 | ✅ `npm test` 18/18 |

## Status da execução

Todas as 6 tasks concluídas em 08/08/2026. Commits da leva, em ordem:

| Commit | Task |
|---|---|
| `65ebc91` | 1 (prefactor) + 2 (sem emoji) |
| `a549686` | 3 (claim no Postgres) |
| `d564232` | 5, Steps 1-2 e 4 (anti-bot puro) |
| `1bbf837` + `337356d` | 4, parte pura (agenda do debounce) + os furos da revisão de cobertura |
| `b3b89e0` | 4, Step 3 (ciclo de I/O do turno) |
| `7f74200` | 5, Step 3 (anti-bot ligado no turno) |
| `f872c94` | 4, Steps 2, 4 e 5 (**o corte do webhook** + teste de concorrência) |
| `5152a45` | 6 (varredura de boot + handler de SIGTERM) |

**A única lacuna de cobertura conhecida é o CA4**: o caminho em que o anti-bot dispara nunca é exercitado ponta a ponta. Custaria três turnos idênticos com o modelo de verdade, e o `test:turno` já é opt-in e caro. Fica registrado em vez de silenciado.
