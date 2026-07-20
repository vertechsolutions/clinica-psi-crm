# Contexto — Clínica Cazule · Assistente Camila (WhatsApp)

Este documento é o handoff de uma sessão de trabalho (Claude no Cowork) para outra
sessão (Claude Code no terminal, com acesso ao Railway). Use como contexto de
projeto e como checklist antes do deploy.

## Quem é quem

- **Bruna** — psicóloga, atendente da recepção da Clínica Cazule (clínica de psicologia com 8 psicólogas). Cliente final.
- **Camila** — a atendente **virtual** (IA). Nome fictício, personifica a recepção da clínica no WhatsApp.
- **Murilo (você)** — CTO do projeto (Vertech).
- **WhatsApp de teste** — WhatsApp Cloud API, número da clínica (`WHATSAPP_PHONE_NUMBER_ID=1121282344409820`).
- **Notificações de handoff (fase de teste)** — devem chegar no WhatsApp da Bruna (`+55 27 98117-8233`) e no seu (`+55 49 99955-1051`).

## Arquitetura

- Next.js 16 (App Router, `--webpack`) + React 19 + Tailwind 4
- IA: **Google Gemini 2.5 Flash** (`@google/genai`) — conversa + triagem estruturada
- Transcrição de áudio: Gemini multimodal (arquivo `src/lib/transcribe.ts`)
- Banco: **Postgres** (Railway) via `pg` — schema criado no boot pelo `instrumentation.ts`
- Mensageria: **WhatsApp Cloud API v25.0** (Graph API) — cliente em `src/lib/whatsapp.ts`
- Deploy: **Railway** com auto-deploy no push pra `master` (repo `vertechsolutions/clinica-psi-crm`)

Tabelas Postgres:
- `wa_conversations (wa_id PK, nome, lead JSONB, pronto, pausada, pausada_em, created_at, updated_at)`
- `wa_messages (id, wa_id, role, content, wamid UNIQUE, created_at)`
- `app_config (key PK, value, updated_at)` — chave `system_prompt` sobrescreve o `DEFAULT_PROMPT` do código

## Demandas da Bruna (reunião 08/07/2026)

1. **Interpretar áudio dos pacientes** — clínica atende só por texto, mas paciente às vezes manda áudio. Transcrever e tratar como texto.
2. **Planilha no Google Drive** com horários das psicólogas (integração pra IA consultar).
3. **Proatividade / follow-up** — reengajar leads que sumiram (mensagem 7 do FAQ da Bruna).
4. **Enviar formulário DEPOIS do pagamento** (não antes).
5. **Criar email** `camila@vertechsolucoes.com.br` pra receber a planilha compartilhada.
6. **FAQ** — Bruna mandou PDF com 19 perguntas/respostas (arquivo `Documento sem título (8).pdf` na raiz).
7. **Respostas mais curtas** — se longa, quebrar em várias.
8. **Desligar IA após enviar form** — pausa e notifica Bruna + você no WhatsApp.

## O que já foi implementado (Cowork, 14/07/2026)

Todas as mudanças estão neste commit local, **ainda não pushadas**:

### Áudio (item 1)
- **NOVO `src/lib/transcribe.ts`** — `transcribeAudio(bytes, mimeType)` via Gemini multimodal. Modelo configurável por `GEMINI_TRANSCRIBE_MODEL` (default cai no `GEMINI_MODEL`). Limite inline 15MB. Retorna `null` em falha (não lança).
- **`src/lib/whatsapp.ts`** — adicionadas duas funções:
  - `downloadMedia(mediaId)` — 2 passos (GET `/{media_id}` pra URL assinada, GET nessa URL). Retorna `{bytes, mimeType}` ou `null`.
  - `sendInternalAlert(to, body)` — envia mensagem interna (best-effort, não lança).
- **`src/app/api/whatsapp/webhook/route.ts`** — detecta `msg.type === 'audio' | 'voice'`, baixa, transcreve, injeta no histórico como `[áudio transcrito]: <texto>`. Fallback pede texto se transcrição falhar.

### FAQ da Bruna incorporado (itens 6, 7, 4)
- **`src/lib/default-prompt.ts`** — reescrito com:
  - Abertura da Bruna: "Seja bem-vindo(a) à Cazule. Me chamo Camila… individual ou casal?"
  - Valores individual: R$75 avulsa / R$280 pacote / R$150 quinzenal / 45min
  - Valores casal: R$150 avulsa / R$550 pacote / 50min
  - Infanto-juvenil 13+ (primeira sessão só com responsável)
  - Terapia de casal em 3 fases
  - Nota Fiscal, Relatório, Atestado (com regras), Declaração de comparecimento
  - Não aceita plano de saúde direto (só reembolso via NF)
  - Não faz sessão experimental
  - **Regra de resposta curta**: 1–3 frases, ≤400 chars, quebrar em vários turnos
  - **Fluxo do form**: só envia DEPOIS do comprovante
  - Mensagem de retenção (mensagem 7 do FAQ) documentada pro cron de follow-up
- **`PROMPT_VERSION`** bumped pra `2026-07-13-cazule-v4-faq-bruna`.

### Handoff pós-pagamento (itens 4, 8)
- **`src/lib/triagem.ts`** — novo campo `enviarForm: boolean` no `TriagemResult`, no `responseSchema` do Gemini, no `normalize()`, e no `EXTRACTION_GUIDE` (regra: só marca true no turno em que envia o form após o comprovante).
- **`src/lib/schema.ts`** — `ALTER TABLE ADD COLUMN IF NOT EXISTS pausada BOOLEAN NOT NULL DEFAULT FALSE, pausada_em TIMESTAMPTZ` em `wa_conversations`. Idempotente.
- **`src/lib/conversation.ts`** — três funções novas:
  - `pauseConversation(waId)` — marca `pausada=true` e `pausada_em=now()`.
  - `isPaused(waId)` — retorna se a conversa está pausada.
  - `computeReply` — agora substitui `{FORM_URL}` no prompt pelo valor de `process.env.FORM_URL` e retorna também `enviarForm`.
- **Webhook** — antes de responder, checa `isPaused` (IA fica muda mas grava mensagens do paciente). Após responder, se `turno.enviarForm === true`, chama `pauseConversation` + `notifyTeam` (envia resumo pra `NOTIFY_ALERT_NUMBERS`).

### Planilha modelo (itens 2, 5)
- **NOVO `planilha-horarios-modelo.xlsx`** (na raiz) — 4 abas:
  - **Instruções**: como preencher + regras da clínica
  - **Psicólogas**: catálogo (nome, CRP, abordagens, atende individual/casal/infanto)
  - **Grade Semanal**: matriz psicóloga × dia da semana com janelas de horário
  - **Agenda**: agendamentos concretos (paciente, data, hora, psicóloga, modalidade, status, valor, pagamento, NF)
- Bruna preenche esse modelo com os dados reais. Depois, na próxima leva, integramos com Google Drive lendo pela API.

### Env vars novas (item `.env.example` atualizado)
```
FORM_URL=                               # Google Forms da Bruna (obrigatório pra o form ir com link)
NOTIFY_ALERT_NUMBERS=5527981178233,5549999551051  # Bruna, Murilo (E.164 sem "+")
GEMINI_TRANSCRIBE_MODEL=gemini-2.5-flash-lite      # opcional, mais barato pra áudio
```

## Leva 2 — implementada em 17/07/2026 (branch `feat/camila-melhorias`)

Plano completo em `docs/superpowers/plans/2026-07-17-camila-ia-melhorias.md`. Testada com
simulação Gemini (paciente individual, casal e lead frio) + revisão Fable + 2 revisões
independentes (código e segurança/LGPD). Principais entregas:

- **Bolhas (item 7)** — `src/lib/split-message.ts` (`splitReply`) + `sendTextSequence` no
  cliente WhatsApp: resposta com parágrafos/longa vira 2–3 mensagens com respiro de ~900ms.
- **Agenda no Sheets (itens 2/5)** — `src/lib/agenda-core.ts` (parsers puros + resumo com
  tags individual/casal/infanto e filtro de reservas passadas) + `src/lib/sheets.ts`
  (Service Account JWT + cache 60s + fallback gracioso). O bloco é APPENDADO ao prompt em
  `computeReply` (vale mesmo com prompt vindo do `app_config`). Diagnóstico:
  `npx tsx --env-file=.env.local scripts/test-sheets-live.ts`.
- **Follow-up (item 3) — código pronto, ADIADO por decisão de 17/07** — `src/lib/followup.ts`
  (canal dominante: TEMPLATE Meta, pois o lead frio por definição passa da janela de 24h;
  o texto livre da msg 7 é fallback de exceção; teto 2x por lead; telefone mascarado nos
  logs; a mensagem enviada é persistida no histórico pro modelo ter contexto na resposta).
  OPT-IN: só liga com `FOLLOWUP_ENABLED=true`. Falta: template `retomada_atendimento`
  aprovado na Meta + opt-out explícito antes de ligar.
- **Prompt v7** (`2026-07-17-cazule-v7-agenda-antialucinacao`) — REGRA DURA DE AGENDA (sem
  bloco [AGENDA DA CLÍNICA], nunca inventar psicóloga/horário nem avançar a pagamento — a
  v6 fechava venda sobre slot inexistente quando cobrada num follow-up), nunca repetir
  mensagem, uma pergunta por vez, pagamento sem fricção, valores em 2 bolhas.
- **FORM_URL resolvido** — o form real da clínica ("Formulário Clínica Cazule", bate 1:1 com
  a ficha de 18 campos) é público e validado sem login:
  `https://docs.google.com/forms/d/1A1DWxfinQWBU1oulWQRP7zsmKW6DHL6jjRXzzzX5bhg/viewform`

### Credenciais Google (status 17/07, em andamento com o Murilo)
- Workspace `vertechsolucoes.com.br` ativo; mailbox `camilaia@` criado.
- Org policy `iam.disableServiceAccountKeyCreation` BLOQUEIA criação de chave de service
  account em projetos da organização (aconteceu 2x: projetos `cazule-camila` e
  `camila-ia-do-murilo`, ambos caíram dentro da org). Saídas: (A2) criar projeto na conta
  pessoal com "Sem organização" no campo Local, ou (B) dar-se o papel "Administrador de
  políticas da organização" e sobrescrever a política no projeto.
- Depois: planilha `Cazule — Agenda` (upload do `planilha-horarios-modelo.xlsx` → Salvar
  como Planilhas Google no Drive do `camilaia@`) compartilhada com o e-mail da service
  account (Leitor) → `GOOGLE_SERVICE_ACCOUNT_JSON` + `AGENDA_SHEET_ID` no Railway.

## Leva 3 — revisão e2e + replay dos logs reais (18/07/2026)

- **Áudio quebrou em produção e foi corrigido**: `GEMINI_TRANSCRIBE_MODEL=gemini-2.5-flash-lite`
  retornava 404 ("no longer available to new users"). A env foi REMOVIDA do Railway
  (fallback: `gemini-2.5-flash`, que aceita áudio — validado). ⚠️ NUNCA setar modelo de
  transcrição sem antes validar com `npx tsx --env-file=.env.local scripts/test-transcribe-live.ts`.
- **Replay com logs reais** (`scripts/replay-conversas.ts`): re-roda as conversas reais do
  Postgres (turnos de usuário) contra o prompt atual + agenda real, lado a lado com as
  respostas antigas. Rode com `DATABASE_PUBLIC_URL` no ambiente (não commitar saída — LGPD).
- **Prompt v10/v10.1** (a partir da avaliação Fable de 48 turnos reais): regra de janela
  (manhã/tarde/noite), consistência da proposta (não trocar de psicóloga a cada turno),
  datas de calendário só se escritas no bloco, anti-mimetismo (instruções vencem o
  histórico do prompt velho — a IA chegou a copiar promessa de form pré-comprovante),
  proibido "vou verificar a agenda... te aviso" com bloco presente, retomada de paciente
  conhecido, nomes de psicólogas (2-3 compatíveis), mensagem ininteligível, cantada com
  limite educado.
- **Postgres**: o "deploy antigo" do serviço Postgres no Railway é só o container do banco
  (não muda mesmo). Os DADOS são a memória da Camila (`wa_messages` → contexto do Gemini
  via `loadHistory`; `wa_conversations` → ficha/handoff; `app_config` → prompt calibrável).
- **Backlog identificado no replay** (padrões reais sem goal): debounce de mensagens
  repetidas/ruído antes de acionar a IA; sinal interno de prioridade pra equipe em quadro
  grave não-suicida (ex.: "ouço vozes"); bios curtas das psicólogas aprovadas pela Bruna;
  cenário de teste "lead conhecido retorna dias depois".

## Leva 4 — Pix automático + pipeline proativo (18/07/2026, v11+v12 NO AR, commit 87be570)

- **Pix automático (v11)**: env `PIX_INFO` (⚠️ TESTE: celular da Bruna +55 27 98117-8233 —
  trocar pela chave oficial via `railway variable set PIX_INFO=...`, sem deploy). Placeholder
  `{PIX_INFO}` substituído em `computeReply` como o `{FORM_URL}`; sem env, fallback gracioso
  (a Camila diz que vai encaminhar e a equipe manda manualmente). A Camila envia chave+valor
  NA MESMA MENSAGEM em que o paciente escolhe avulsa/pacote e já pede o comprovante.
- **Pipeline proativo (v12)**: seção "PIPELINE DA CONVERSA" no prompt — funil de 9 etapas;
  TODA resposta engata a próxima etapa pendente; resposta passiva ("ok","sim") = sinal verde
  pra avançar; "fico à disposição" proibido no meio do funil; acolhimento vem antes de
  pergunta comercial quando há dor.
- **Validação**: persona passiva no `sim-conversa.ts` (paciente que NUNCA pergunta) fechou o
  funil inteiro em 11 turnos — valores → nome → queixa → horário real da agenda → Pix com
  chave+valor → comprovante → form → handoff. Suíte `test-triagem` 11/11 (o harness agora
  injeta agenda fake — sem ela a REGRA DURA trava o Passo 3 e cenários de agendamento não
  fecham; lição importante pra testes futuros). `sim-conversa.ts` aceita filtro por nome de
  persona via CLI (ex.: `npx tsx --env-file=.env.local scripts/sim-conversa.ts passivo`).
- **Estado de produção**: funil 100% automático da primeira mensagem até o comprovante; a
  equipe humana entra só pra conferir o pagamento e assumir após o handoff.
- Mensagem de status pra Bruna pronta em `mensagem-bruna.md` (formatação WhatsApp).

## Leva 5 — Anti-repetição + brechas de simulação (20/07/2026, v13, commit 2213e4e)

Bug REAL reportado pela Bruna (print de 19/07, teste de uma amiga): a Camila repetiu a mesma
mensagem duas vezes, idêntica, quando a paciente disse "seria melhor vocês sugerirem". Duas
falhas: repetição literal (regra de prompt é probabilística) e a causa-raiz — quando o paciente
DEVOLVE a decisão, a Camila não tinha instrução de decidir e colapsava na repetição.

- **Trava determinística (`src/lib/anti-repeat.ts`)**: `runTriagemSemRepeticao()` (wrapper do
  `runTriagem`, usado pelo `computeReply` E por todos os harnesses) compara a resposta com a
  última mensagem da assistente (normalização + Dice ≥ 0.9); se repetiu, refaz UMA vez com
  aviso explícito no system; se persistir, loga `[anti-repeat] persistiu` e envia (sem loop).
  Monitorar esse log em produção — warn simples = trava agindo, ok.
- **Prompt v13** (`2026-07-20-cazule-v13-decide-e-nao-repete`): paciente pede sugestão ou
  devolve a decisão → Camila SUGERE UMA abordagem na hora (ex.: TCC pra conflitos de casal)
  e engata a próxima etapa; oferta de escolha no máximo 1x por conversa; reforço na regra
  de TOM (percebeu que ia repetir = mude a tática e avance o funil).
- **Brechas achadas em simulação (e corrigidas)**:
  1. **JSON cru vazava pro paciente**: modelo às vezes emite o JSON com quebras de linha
     LITERAIS (inválido); o fallback antigo mandava o texto cru como fala. Agora
     `parseSaidaModelo()` (triagem.ts) recupera (escapa/achata as quebras — salva resposta E
     ficha) e, se irrecuperável e parece JSON, suprime (vira a mensagem amigável do caller).
  2. **Slot reservado sendo oferecido**: o bloco "Já reservado" só tinha data numérica e o
     modelo errava a conta dd/mm→dia da semana. `resumoDisponibilidade` agora prefixa o dia
     da semana em cada reserva ("segunda-feira 20/07/2026 18:00").
- **Fixture do cenário luto corrigido**: pedia "segundas de manhã" mas a agenda fake não tem
  manhã de segunda — a Camila (corretamente, REGRA DE JANELA) negava e o `pronto` não fechava.
  Agora pede "segundas à tarde" (janela real). Lição: fixtures de disponibilidade precisam
  bater com as janelas da agenda fake.
- **Validação**: `test-triagem` 12/12 (cenário novo do bug passou 3/3 execuções);
  `test-anti-repeat` + `test-parse-modelo` (novos, puros); persona INDECISA nova no
  `sim-conversa` (devolve toda decisão — Camila decidiu tudo, funil fechou até o Pix, e
  desviou do slot reservado propondo 19h); replay das 6 conversas reais do Postgres — no
  turno exato do bug a Camila agora sugere TCC direto, e a trava agiu ao vivo na conversa
  do paciente que repetia a mesma frase.

## Leva 6 — Nome completo + comprovante lido de verdade + alerta com checklist (20/07/2026, v14, commit fceb42b)

Do teste real do Murilo (49999551051): "Murilo M" passou como nome completo e um comprovante
qualquer disparou o handoff. Três entregas:

- **Nome completo (prompt v14)**: nome de 1 palavra ou com inicial ("Murilo M") → a Camila pede
  UMA vez o nome completo ("é pra ficha da psicóloga 😊") e segue mesmo sem resposta (não trava).
- **Comprovante LIDO (Gemini vision)**: `src/lib/comprovante.ts` (análise da imagem/PDF:
  ehComprovante, valor, nomeDestinatario, chaveDestino, instituição, data) +
  `src/lib/comprovante-core.ts` (puro: `verificarDestinatario` — chave por sufixo de 8 dígitos,
  e-mail por containment, nome só como sinal fraco; `montarMarcadorComprovante` — marcador rico
  que substitui a imagem no histórico; `chaveEsperada` — env `PIX_CHAVE` opcional, senão deriva
  da `PIX_INFO`). O prompt valida o VALOR contra a opção combinada (só ele sabe o que foi
  escolhido); **backstop no webhook**: chave não confere OU não-é-comprovante + modelo marcou
  enviarForm → suprimido por código (log `[comprovante] enviarForm suprimido`). **Fail-open**:
  análise falhou → fluxo antigo (marcador simples) + "⚠️ conferir manualmente" no alerta.
- **Alerta de handoff virou notificação de trabalho** ("Camila (IA) concluiu mais uma triagem
  automática!"): ficha + linha do comprovante (valor lido + veredito da chave) + checklist
  (1 conferir pagamento, 2 conferir formulário, 3 ajustar horário no PsicoManager). Quem recebe
  e intervém é a BRUNA AMORIM (psicóloga, +55 27 98117-8233 — já está em `NOTIFY_ALERT_NUMBERS`
  junto com o Murilo). "Camila" é só o nome fictício da IA.
- **Validação**: units novos `test-comprovante-core` ✔; suíte com 15 cenários (3 novos: nome
  incompleto 3/3, valor errado 3/3 — "o comprovante veio de R$ 550, mas o combinado foi R$ 75" —
  e chave errada bloqueada); persona passiva fechou o funil em 9 turnos no v14 (fail-open ok e,
  de bônus, não re-perguntou "avulsa ou pacote" já respondido). Obs.: rede local instável na
  sessão gerou "fetch failed" esporádicos nos testes — não é bug do produto.
- **Diagnóstico com comprovante real**: `npx tsx --env-file=.env.local scripts/test-comprovante-live.ts <imagem-ou-pdf>`
  mostra a análise + o marcador exato que a Camila veria.

## Armadilhas conhecidas (leia antes de deployar)

### 1. O prompt do WhatsApp pode não vir do código
`getActivePrompt()` em `src/lib/conversation.ts` retorna primeiro o que estiver salvo em `app_config.system_prompt`. Se a Bruna (ou eu) calibrou algo pela tela `/` antes, é ELE que roda. Trocar o `DEFAULT_PROMPT.ts` não muda nada se o DB tem valor. **Duas opções**:
- (a) Abrir a tela de calibração `/`, colar o novo prompt manualmente e clicar Salvar.
- (b) `DELETE FROM app_config WHERE key='system_prompt'` pra ele voltar a usar o `DEFAULT_PROMPT` do código (usar CLI do Railway: `railway connect postgres` → SQL).

### 2. `enviarForm` precisa dos dois lados
- No **prompt** (`DEFAULT_PROMPT`): diz PRA IA quando marcar true.
- No **schema Gemini** (`triagem.ts`): declara o campo — sem isso, o Gemini não devolve.
Se a etapa (1) foi aplicada e ficou só o prompt no DB **sem** falar de `enviarForm`, a IA nunca vai marcar true e o handoff nunca dispara. **Ao atualizar o prompt no DB, mantenha as instruções sobre `enviarForm`.**

### 3. WhatsApp `audio` vs `voice`
No payload da Meta, mensagem de microfone pode vir como `type: "audio"` com `audio.voice: true`. Meu webhook trata `msg.type === 'audio' || msg.type === 'voice'` — os dois caminhos leem `msg.audio?.id || msg.voice?.id`. Se em produção só vem `audio`, o fallback pega. Se der erro, checar payload real.

### 4. CRLF no repo
O repo tem line endings CRLF (Windows). Do sandbox Linux do Cowork, o `git status` mostrou TODOS os arquivos como modificados. As mudanças reais estão apenas em:
```
src/lib/default-prompt.ts
src/lib/transcribe.ts         (novo)
src/lib/whatsapp.ts
src/lib/conversation.ts
src/lib/schema.ts
src/lib/triagem.ts
src/app/api/whatsapp/webhook/route.ts
.env.example
planilha-horarios-modelo.xlsx (novo)
Documento sem título (8).pdf  (FAQ da Bruna, novo — decidir se commita ou .gitignore)
CONTEXTO-CAZULE.md            (este arquivo)
```
**No commit, `git add` só esses arquivos** — não use `git add -A`.

### 5. Sem `NOTIFY_ALERT_NUMBERS`, o handoff é silencioso
`notifyTeam` só loga um warning se a env var estiver vazia. Confirmar que está setada no Railway ANTES de considerar o item 8 pronto.

### 6. Sem `FORM_URL`, o link do form fica placeholder
`computeReply` substitui `{FORM_URL}` pelo valor de `process.env.FORM_URL`. Se não setar, o placeholder vaza literal.

## O que ainda falta (levas seguintes)

- **Ligar o follow-up** (item 3 — código pronto na Leva 2): aprovar template
  `retomada_atendimento` na Meta, implementar opt-out explícito ("não quero mais contato"
  → pausa), validar cadência com a Bruna, e só então `FOLLOWUP_ENABLED=true`.
- **Credenciais Google em produção** (itens 2, 5): concluir a chave da service account
  (bloqueio de org policy — ver Leva 2) e setar `GOOGLE_SERVICE_ACCOUNT_JSON` +
  `AGENDA_SHEET_ID` no Railway.
- **Criptografia em repouso do campo `lead`** (dados clínicos, LGPD) — mencionado no README, ainda pendente.
- **Fila durável do webhook** — hoje é `after()` in-process; se crashar entre 200 e o envio, mensagem fica órfã.
- **PsicoManeja** (agenda/prontuário) e confirmação de pagamento via API bancária
  (comprovantes falsos são dor real) — backlog do piloto.

## Como validar após deploy

1. Sanity build local: `pnpm build` — 0 erros de tipagem.
2. Smoke test da triagem: `npx tsx --env-file=.env.local scripts/test-triagem.ts` — pelo menos os cenários existentes continuam passando (curioso, cantada, preço, abordagem, interessada, luto, indeciso).
3. Testar áudio: mandar um áudio pro número da clínica de um WhatsApp de teste. Deve aparecer resposta em texto natural (a IA "leu" o áudio) — não deve mais aparecer "consigo te ajudar melhor por texto".
4. Testar fluxo de casal: perguntar "é individual ou casal?" e depois "quanto é pra casal?" — deve responder R$150/R$550/50min.
5. Testar handoff: fazer o fluxo completo até "vou te enviar o comprovante" e depois mandar um "aqui está o comprovante" (ou uma imagem — vai virar `[image]`). A IA deve responder com a mensagem de confirmação + link do form e, na sequência, você e a Bruna devem receber alerta no WhatsApp. Depois disso, qualquer mensagem do paciente deve ser gravada mas SEM resposta da IA.
