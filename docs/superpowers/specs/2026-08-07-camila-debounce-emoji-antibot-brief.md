---
slug: camila-debounce-emoji-antibot
data: 2026-08-07
fase: brief (escopo)
status: aprovado
gate: 1
aprovado_em: 2026-08-07
aprovado_por: Murilo
---

# Leva 12 — Debounce, sem emoji e anti-bot (brief de escopo)

> Artefato da Fase 0 do ADP (grill-me). Input único do design. Enquanto `status: rascunho`, o gate de escopo não passou.

## Problema

A Camila responde **duas vezes a mesma coisa** quando o lead manda duas mensagens seguidas — o comportamento mais denunciador de IA que existe num atendimento. Evidência: print de 06/08/2026, número `+55 49 9973-7313` (Ingrid Manoela), que mandou "Oiii" e "Oii" às 17:59 e recebeu o mesmo par de bolhas duplicado no mesmo minuto.

Quem sofre: o lead, que percebe na hora que não tem gente do outro lado; e a Bruna, que vende atendimento humanizado de psicologia e teve a ilusão quebrada na primeira mensagem da conversa.

Junto vieram mais duas pedidas da Bruna: **tirar os emoji** das mensagens da Camila, e **perceber quando o outro lado é um bot/IA** para não entrar em loop infinito de mensagens.

### Causa-raiz da duplicação (confirmada no código, não suposta)

Não existe nenhum lock por conversa em todo o repositório — a busca por `advisory_lock|mutex|inFlight|FOR UPDATE` em `src/` só encontra o lock de migração de schema (`src/lib/schema.ts:4,23`).

Duas mensagens do lead chegam como **dois POST HTTP distintos**. Cada um agenda seu próprio `after()` (`src/app/api/whatsapp/webhook/route.ts:257`), e nada os serializa por `wa_id`. Ambos chamam `loadHistory` **antes** de qualquer `persistReply`, então os dois turnos do Gemini rodam com histórico idêntico e produzem a mesma resposta.

O guard anti-repetição existente (`src/lib/anti-repeat.ts:68`, `runTriagemGuardada`) **não protege disso**: ele compara a resposta gerada contra a última mensagem da assistente **no histórico carregado** — que é o mesmo nos dois turnos. A duplicata nasce fora do alcance dele. O plan de 20/07 que criou esse guard não menciona concorrência em lugar nenhum; assumiu implicitamente um turno de geração por vez.

Também não existe debounce, fila ou buffer em lugar nenhum. Todos os `setTimeout` do repo são outra coisa: respiro de 2s no tratamento do eco (`route.ts:179`), 900ms entre bolhas de uma mesma resposta (`whatsapp.ts:56,70,82`), `delayTyping` do provider (`zapi.ts:277`), backoff de retry, e os crons de 1h/24h.

## Critérios de sucesso (testáveis)

1. **Duas mensagens do lead em rajada geram UMA resposta.** Teste: dois POST concorrentes no webhook para o mesmo `wa_id` (`Promise.all`) resultam em exatamente uma chamada ao Gemini e um envio. Hoje esse teste não existe — `scripts/test-webhook-http.ts` só faz cenários sequenciais.
2. **A resposta considera todas as mensagens da rajada.** Teste: lead manda "oi" + "quanto custa?" em sequência; a resposta única responde ao preço, não só ao cumprimento.
3. **Zero emoji no que chega ao lead.** Teste: `semEmoji()` remove pictográficos, ZWJ, variation selectors e skin tones, e **preserva** acentuação portuguesa (ã, ç, é) e o bullet `•` usado nas listas.
4. **Três turnos idênticos consecutivos do lead pausam a conversa e alertam a equipe.** Teste: função pura de detecção retorna `true` no terceiro idêntico e `false` no segundo; a pausa reusa `pauseConversation` e dispara `sendInternalAlert`.
5. **Nada do que já funciona quebra.** `npm test` (a suíte pura, 15 scripts) continua verde, com os testes novos registrados no array `PUROS` de `scripts/test-all.ts`.

## Abordagem escolhida

### 1. Debounce cancelável em memória + advisory lock no Postgres (defesa em profundidade)

Ponto de entrada: dentro do `after()` do webhook, **depois** de `recordUserMessage` (que mantém o dedup por `wamid` e o histórico como hoje) e **antes** de `computeReply`.

- Cada mensagem cancela o timer pendente daquele `wa_id` e agenda um novo de **8 segundos**. Só o silêncio dispara a resposta.
- Quando o timer dispara, o turno adquire `pg_try_advisory_lock` derivado do `wa_id`. Se não pegar, desiste em silêncio — outro turno já está respondendo.
- `computeReply` já lê o histórico inteiro do banco (`src/lib/conversation.ts:266`). Ou seja: **"ler todas as mensagens antes de responder" sai de graça** — basta esperar e chamar uma vez. Nenhuma mudança em `computeReply` é necessária para agregar.

Por que os dois mecanismos e não só um: o debounce resolve o caso comum (rajada) e o lock cobre o que o debounce não vê — restart no meio da janela, e um eventual segundo processo no futuro. O custo do lock é uma query.

Módulos novos: `src/lib/turno.ts` (buffer e agendamento) e `src/lib/lock.ts` (advisory lock com client dedicado do pool).

**Mitigação obrigatória do risco que este mecanismo cria:** hoje a resposta é imediata; com uma janela de 8s, um restart do processo no meio dela engole a resposta e o lead fica sem retorno (o retry do provider cai no `ON CONFLICT` do `wamid` e é descartado — limitação já documentada em `route.ts:211-213`). Portanto entra no escopo uma **varredura de pendentes no boot** (`src/instrumentation.ts`): conversas cuja última mensagem `user` é mais recente que a última `assistant` e está dentro de uma janela curta são processadas na subida. Isso fecha de quebra um bug antigo.

### 2. Emoji: filtro determinístico na saída + limpeza do prompt

Os dois, não um ou outro — porque o prompt **instrui e demonstra** emoji hoje, e porque o prompt efetivo pode vir do banco.

- `src/lib/emoji.ts` novo: `semEmoji(texto)` sobre `\p{Extended_Pictographic}` + U+FE0F + U+200D + skin tones + keycaps. **Nunca** `\p{Emoji}` — ver estado da arte abaixo.
- Aplicado no ponto único de saída, `bolhasDoTurno` (`src/lib/fechamento.ts:41`), que já é por onde passa tanto o fechamento oficial quanto o `splitReply`.
- Limpeza do prompt: `default-prompt.ts:12` (a instrução `com "•" ou um emoji` vira só `•`), e os exemplos em `:33`, `:56`, `:124`, `:158`. Bump do `PROMPT_VERSION`.
- Limpeza das mensagens fixas que vão ao lead **sem passar pelo LLM** e que o filtro de `bolhasDoTurno` não cobre: `route.ts:44` (`PEDE_TEXTO`), `route.ts:46` (`PEDE_TEXTO_OUTRAS_MIDIAS`), `comprovante-core.ts:116`.
- `scripts/sync-prompt.ts` novo: alinha `app_config.system_prompt` com o código, rodado manualmente contra `DATABASE_PUBLIC_URL`.

Os alertas internos (`notifyTeam`, `route.ts:398-415`) **mantêm** os emoji — são para a equipe, não para o lead, e servem de marcador visual de campo.

### 3. Anti-bot: 3 turnos idênticos consecutivos → pausa + alerta

Gatilho: três **turnos** consecutivos do lead com conteúdo idêntico após normalização (reusando `normalizaComparacao` de `anti-repeat.ts`).

O detalhe que torna isso seguro: como o debounce agrega a rajada, o lead ansioso que manda "oi", "oi", "oi" em três segundos vira **um** turno, não três. Para chegar a três turnos idênticos, o outro lado precisa mandar "oi", receber resposta, mandar "oi" de novo, receber resposta, e repetir — comportamento que um humano praticamente não tem e um bot em loop tem sempre. **O debounce derruba o falso positivo do anti-bot antes de ele existir.**

Ação: `pauseConversation(waId)` (mecanismo que já existe) + `sendInternalAlert` para `NOTIFY_ALERT_NUMBERS` com número, motivo e as três mensagens. Não responde.

Efeito colateral que já está correto de graça: `followup.ts:62` exclui `pausada=TRUE` das buscas de leads frios, então a conversa pausada por bot não recebe reengajamento.

### Alternativas descartadas

| Alternativa | Por que não |
|---|---|
| Só debounce, sem lock | Resolve a rajada mas não o restart nem um segundo processo. O lock custa uma query. |
| Só lock, sem debounce | Serializa os dois turnos, mas o segundo ainda responde — vira duas respostas em sequência em vez de duas simultâneas. Não atende o "ler todas as mensagens antes de responder". |
| Fila no Postgres com polling (tabela de turno pendente) | Robusto a restart e a múltiplas réplicas, mas adiciona polling e complexidade a um app que hoje é single-process. Reavaliar se o Railway escalar. |
| Cooldown de 30min no anti-bot em vez de pausa | Mais seguro contra falso positivo, mas exige auto-retomada, que não tem precedente no código (a IA nunca despausa sozinha). O alerta pra equipe resolve o falso positivo com menos maquinário. |
| Só filtro de emoji, sem tocar no prompt | O modelo continuaria sendo instruído a gerar emoji para a gente descartar, e o prompt ficaria dessincronizado do código. |
| Debounce adaptativo (esperar mais se a frase parece incompleta) | Mais natural, mais superfície para calibrar e testar. Fica no backlog. |

## Decisões e termos

- **Turno**: uma rodada completa de geração e envio. Após esta leva, um turno pode conter **várias mensagens do lead** agregadas — antes era sempre 1:1.
- **Janela de debounce**: 8 segundos de silêncio. Cancelável: cada mensagem nova reinicia. O lead vê a resposta em ~12s somando Gemini (~3s) e `delayTyping`.
- **Bot detectado**: três turnos consecutivos com conteúdo normalizado idêntico.
- **Escopo do "sem emoji"**: apenas o que chega ao lead. Alertas internos mantêm.
- Decisão de arquitetura herdada: mecanismos determinísticos em módulos puros, testáveis sem rede — o mesmo padrão de `contato.ts`, `conducao.ts` e `fechamento.ts`. A detecção de bot e o filtro de emoji são funções puras; só o agendamento e o lock tocam I/O.

## Restrições

- **Stack**: Next.js 16 App Router, container long-running no Railway (`next start`), Postgres via `pg` cru sem ORM, Gemini 2.5 Flash, Z-API. Sem Redis, sem fila, sem Jest/Vitest.
- **Migração de schema**: só o padrão de `src/lib/schema.ts` — `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` dentro de `initSchema()`, idempotente, rodado no boot. Não há migration runner.
- **Testes**: scripts `tsx` com `node:assert`, registrados no array `PUROS` de `scripts/test-all.ts`.
- **Uma réplica**: `railway.json` não define `numReplicas`, e os crons de `instrumentation.ts` rodam sem leader-election — o desenho assume instância única. O buffer em memória é seguro sob essa premissa; o advisory lock é o seguro contra ela mudar.
- **LGPD**: nenhum dado novo de paciente é coletado. O alerta de bot expõe número e mensagens só para `NOTIFY_ALERT_NUMBERS`, mesmo canal já usado pelo `notifyTeam`.
- **Custo**: `runTriagemGuardada` já pode gastar 2 chamadas Gemini por turno. Agregar a rajada num turno só **reduz** custo em relação a hoje.

## Estado da arte (fusão dos achados)

| Achado | Fonte | Destino |
|---|---|---|
| Debounce cancelável por chat é o padrão do ecossistema de WhatsApp; cada mensagem reinicia o timer, só o silêncio dispara | [n8n community](https://community.n8n.io/t/whatsapp-debounce-flow-combine-multiple-rapid-messages-into-one-ai-response-using-redis-n8n/225494) | **Opção escolhida** — vira `src/lib/turno.ts` |
| Adapters de chat usam janelas configuráveis e curtas (0,6s a 2s para chunks); agregação de mensagens de cliente costuma olhar até 15s | [hermes-agent #22602](https://github.com/NousResearch/hermes-agent/issues/22602) | **Pergunta de grill** — respondida: 8s |
| Advisory lock é por **sessão**, não por transação: com pool, `lock` e `unlock` em connections diferentes deixam o lock preso até restart | [open-mercato #1154](https://github.com/open-mercato/open-mercato/issues/1154), [guia 2026](https://viprasol.com/blog/postgres-advisory-locks/) | **Risco** — obriga `src/lib/lock.ts` a usar client dedicado (`pool.connect()`), com `release` em `finally` |
| `pg_try_advisory_lock` (não-bloqueante) é o recomendado para evitar execução duplicada | [pgPedia](https://pgpedia.info/p/pg_try_advisory_lock.html) | **Opção escolhida** — desistir em silêncio é o comportamento certo aqui |
| Detecção de loop por ação repetida idêntica N vezes + circuit breaker que interrompe e pede intervenção humana é o padrão em sistemas agênticos | [dev.to](https://dev.to/alessandro_pignati/stop-the-loop-how-to-prevent-infinite-conversations-in-your-ai-agents-ekj) | **Mesa** — valida o desenho da Bruna (3x idênticas → pausa) e reforça que o breaker deve **alertar humano**, não só silenciar |
| `\p{Emoji}` casa dígitos `0-9`, `#` e `*` (são emoji-base de keycap) — armadilha clássica; `\p{Extended_Pictographic}` é o correto | [xjavascript](https://www.xjavascript.com/blog/how-to-remove-emoji-code-using-javascript/) | **Anti-escopo** — proibido `\p{Emoji}` no `src/lib/emoji.ts`; um teste deve provar que preços e números sobrevivem |
| Emoji são sequências compostas (ZWJ, variation selectors U+FE0F, skin tones) — regex ingênua deixa resíduo invisível | [strip-variation-selectors](https://github.com/mathiasbynens/strip-variation-selectors) | **Opção escolhida** — o filtro remove os modificadores junto, e um teste cobre família com ZWJ |

## Riscos e perguntas em aberto

1. **Restart no meio da janela de 8s** engole a resposta. Mitigado pela varredura de pendentes no boot (dentro do escopo). Não elimina a janela de risco, reduz para o intervalo entre o crash e a subida.
2. **Não consta** se a Z-API expõe evento de "digitando" do lead — se expusesse, daria para encerrar a janela assim que ele parasse de digitar. Não achei dado confiável; fica no backlog.
3. **Não consta** se existe sinal no webhook (Meta ou Z-API) indicando que o outro lado é uma Business API. Se existir, seria um detector melhor que a heurística de repetição. Fica no backlog.
4. **Prompt no banco**: enquanto `scripts/sync-prompt.ts` não for rodado contra produção, o prompt efetivo continua com as instruções de emoji. O filtro determinístico garante o resultado visível ao lead, mas o modelo segue gerando emoji para serem descartados. Ação manual do Murilo.
5. **Falso positivo de bot** com lead que copia e cola a mesma pergunta três vezes em turnos separados: a conversa é pausada. Mitigado pelo alerta à equipe, que permite reativar pelo painel. Não é silencioso.
6. `markReadAndType` hoje é chamado por mensagem recebida (`route.ts:306`). Com o debounce, marcar como lida por mensagem continua natural, mas o "digitando" precisa aparecer só no disparo do timer — senão pisca a cada mensagem da rajada. Detalhe de implementação para o design.
7. `route.ts:222` processa só `parseWebhook(raw)[0]`. Na Z-API é 1 mensagem por payload, mas um batch da Meta perderia as demais. **Fora de escopo** desta leva, registrado como dívida.

## Fora de escopo

- Debounce adaptativo por análise da última frase.
- Auto-retomada de conversa pausada (por bot ou por handoff).
- Corrigir `parseWebhook(raw)[0]` para processar batches da Meta.
- Migrar o debounce para tabela no Postgres com polling (só se o Railway escalar para N réplicas).
- Remover emoji dos alertas internos da equipe.
- Alerta para a Bruna quando um paciente responde depois do handoff (backlog aberto desde o plan de 27/07).
- Detecção de bot por cadência (respostas sub-humanas) ou por volume de mensagens por minuto — só a regra das 3 idênticas nesta leva.
