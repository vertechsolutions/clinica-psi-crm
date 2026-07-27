# Leva 11 — Fechamento oficial + retomada sem repetir (design)

**Data:** 27/07/2026
**Origem:** feedback da Bruna no WhatsApp em 27/07 (2 áudios + 4 prints) e chave Pix definitiva enviada em 24/07.
**Escopo:** só o que a Bruna pediu + a troca da chave Pix. A agenda quebrada (Sheets 400) tem spec e plano próprios (Leva 9).

## Problema

### 1. O fechamento vira textão e não é o texto da clínica

Print de 27/07 (`IMG-20260727-WA0008`): depois do comprovante, a Camila manda um balão gigante
("Confirmação realizada, Bruna! Vou te enviar agora um formulário de triagem… Esse é o nosso canal de
atendimento…"). A Bruna, no áudio `PTT-20260727-WA0005`: *"o final não enviar um texto muito longo, meio
que quebrado. Eu vou te mandar o print aqui pra você ver como eu quero."*

Causa: o texto sai da redação do modelo. `default-prompt.ts:145-146` manda "confirme com essa mensagem
exata" — uma frase de ~380 caracteres — e o `splitReply` (teto 350) quebra onde cabe, não onde faz
sentido. É a mesma classe de bug do nome e da condução: **regra de prompt é probabilística**.

A Bruna mandou os textos que quer, com a ordem marcada nos prints:

1. `Este é o nosso formulário, solicito que seja preenchido, pois é através dele que realizaremos o envio da sua triagem para a psicóloga: <link>` — circulado com "se possível, após a confirmação do pagamento enviar essa parte aqui"
2. `Confirmação realizada, após o preenchimento da triagem a psicóloga vai entrar em contato com você pelo WhatsApp.` — "depois colocar"
3. `Caso tenha qualquer dúvida pode me chamar que eu te ajudo.` — segundo parágrafo da mesma mensagem
4. `Caso você não se identifique com a profissional, podemos fazer o remanejamento para outra psicóloga, é só nos avisar.` — circulado com "por último esse circulado"

### 2. Paciente que volta recebe tudo de novo

Áudio `PTT-20260727-WA0004`: *"eu falei 'bom dia, gostaria de terapia' e ela meio que me passou tudo de
novo… eu queria saber se quando for um paciente real isso vai acontecer, ou se ela vai continuar de onde
pausou o atendimento."*

O histórico persiste (`HISTORY_LIMIT = 30`, sem janela de tempo) e o prompt v17 já tem uma "REGRA DE OURO
da retomada" — mas quem decide repetir ou não continua sendo o modelo, e o v17 não recebe nenhum sinal
explícito de que a conversa é uma retomada nem do que já foi dito.

### 3. Chave Pix ainda é a de teste

A Bruna mandou o CNPJ em 24/07 (`53480459000104`). Produção segue com `PIX_INFO` apontando pro celular
dela. Todo comprovante real cairia na chave errada.

## Solução

Três mudanças, na ordem de risco crescente.

### A. Fechamento determinístico (`src/lib/fechamento.ts`, novo)

Módulo puro com os quatro textos da Bruna e uma função que monta as bolhas:

```ts
mensagensDeFechamento(formUrl: string): string[]  // 4 strings, na ordem dela
```

O link entra na primeira mensagem. Sem `formUrl` (ou com o placeholder cru), a primeira mensagem sai sem
link — nunca vaza `{FORM_URL}`.

O mesmo módulo exporta a função que decide o turno inteiro:

```ts
bolhasDoTurno(turno, formUrl)  // enviarForm ? mensagensDeFechamento(formUrl) : splitReply(turno.resposta)
```

**Quem chama é o webhook, depois de todos os backstops** — e isso é o ponto crítico do desenho. O
backstop de comprovante inválido (`route.ts:203`) roda *depois* do `computeReply`: se as bolhas fossem
montadas lá dentro, o fechamento sairia mesmo com `enviarForm` zerado (e `resposta` já seria o próprio
texto oficial, então nem o fallback salvaria). Decidindo no webhook, `enviarForm=false` significa que
nenhuma palavra do fechamento é enviada nem gravada.

O histórico passa a guardar `bolhas.join('\n\n')` — exatamente o que o paciente recebeu.

Por que descartar a redação do modelo em vez de emendar: a Bruna definiu as quatro mensagens do
encerramento; qualquer frase extra é redação não aprovada num momento em que o paciente acabou de pagar.

A tela de calibração (`/api/chat`) chama `runTriagem` direto, não `computeReply`: não é afetada. Os
harnesses (`sim-conversa`, `replay-conversas`) passam a chamar `bolhasDoTurno` — a mesma função da
produção, para nunca divergirem dela.

### B. Bloco `[ONDE PARAMOS]` (`src/lib/retomada.ts`, novo)

Mesmo padrão do `[DADOS DO CONTATO]` que matou o bug do nome: o código lê o histórico, deduz o que já foi
tratado e injeta um bloco no system prompt.

Sinais detectados no histórico (determinísticos, por regex):

| sinal | como detecta |
|---|---|
| valores informados | mensagem da assistente com `R$ 75` / `R$ 280` / `R$ 150` / `R$ 550` |
| modalidade definida | **última** afirmação do paciente com "individual"/"casal", descartando negação ("não é de casal") e pergunta ("individual ou casal?") |
| horário proposto | mensagem da assistente com dia + hora **e** verbo de oferta (livre, reservo, encaixo) — "atendemos das 8h às 20h" não conta |
| Pix enviado | mensagem da assistente com "chave Pix" |
| opção **decidida** | paciente com verbo de decisão + avulsa/pacote/quinzenal — "tem pacote?" não conta |
| comprovante aceito | marcador `COMPROVANTE de pagamento detectado` **sem** os avisos de recusa |
| comprovante recusado | marcador com `NÃO CONFERE` / `NÃO confirme o pagamento` / `NÃO parece ser um comprovante` |
| intervalo | diferença de tempo entre a mensagem atual e a anterior |

Distinguir comprovante aceito de recusado é obrigatório: o marcador de recusa **repete o mesmo
cabeçalho** do aceito (`comprovante-core.ts:79-84`), então um regex ingênuo faria o bloco mandar
"confirmar o pagamento" justamente em cima de um comprovante que a análise rejeitou.

A próxima etapa segue o funil de trás pra frente (comprovante > opção+horário > horário > nome > valores >
modalidade) e **nunca** manda confirmar pagamento ou encerrar — quem decide isso é o marcador da análise
e o backstop. A etapa do primeiro nome só é pulada quando o `[DADOS DO CONTATO]` já resolveu o nome
(`temNome`), senão o bloco faria a Camila deixar de perguntar o nome e o alerta da Bruna chegaria sem ele.

**Dois blocos, não um:**
- `[ONDE PARAMOS]` — só quando o paciente sumiu por 6h+: "não reabra com boas-vindas", "cumprimente em uma
  frase curta e siga".
- `[JÁ TRATADO NESTA CONVERSA]` — mesma conversa em andamento: só a lista factual e a próxima etapa. Mandar
  cumprimentar a cada turno brigaria com a regra de variação de abertura do prompt.

Os dois dizem explicitamente que **se a pessoa pedir de novo, pode repetir** (senão a Camila ficaria muda
em "qual era o valor mesmo?") e que **o histórico vence o bloco** em caso de contradição — ele é um resumo
derivado, não a fonte da verdade.

Só é injetado quando há pelo menos um sinal e o histórico tem 2+ mensagens. Conversa nova segue idêntica
ao que é hoje.

Para o intervalo, `loadHistory` passa a trazer `created_at` além de `role`/`content`.

### C. Chave Pix definitiva (só env, sem deploy)

- `PIX_INFO` = texto com o CNPJ `53480459000104`
- `PIX_CHAVE` = `53480459000104` (env que já existe e tem prioridade em `chaveEsperada()`)

`PIX_CHAVE` explícita importa: `verificarDestinatario` compara o **sufixo de 8 dígitos** dos números que
encontra no texto. Sem ela, qualquer outro número que entre na `PIX_INFO` polui a comparação.

### D. Prompt v18

- Passo 4 perde os dois textos ("mensagem exata" + mensagem do formulário) e passa a dizer: quando o
  comprovante for válido, marque `enviarForm = true` — o sistema envia as mensagens oficiais de
  encerramento; não escreva o texto do formulário nem o link.
- A regra de retomada passa a referenciar o bloco `[ONDE PARAMOS]` como fonte da verdade.
- `PROMPT_VERSION` → `2026-07-27-cazule-v18-fechamento-oficial-e-retomada`.

## O que NÃO muda

- Gatilho e momento do handoff: continua no turno do comprovante válido (pausa + alerta pra Bruna).
- `splitReply`, anti-repetição, condução, comprovante vision, agenda: intocados.
- Conversa nova (sem histórico): comportamento idêntico ao v17.

## Riscos e mitigação

| risco | mitigação |
|---|---|
| Modelo marca `enviarForm` sem comprovante válido → paciente recebe fechamento indevido | a escolha das bolhas acontece **depois** do backstop do webhook, que zera `enviarForm`; `test-fechamento` afirma que com `enviarForm=false` nenhuma das 4 strings sai, e os cenários "valor errado"/"chave errada" do `test-triagem` cobrem ponta a ponta |
| Bloco de retomada manda confirmar pagamento em cima de comprovante recusado | sinal separado (`comprovanteRecusado`), `proximaEtapa` nunca diz "encerrar", teste usa o marcador real de recusa |
| Bloco faz a Camila se recusar a reinformar um valor pedido | regra explícita nos dois blocos + cenário "paciente pergunta o valor de novo" |
| Bloco pula a etapa do primeiro nome | `temNome` vem do `[DADOS DO CONTATO]`; teste cobre os dois casos |
| Bloco novo compete com `[DADOS DO CONTATO]` e infla o prompt | os dois são curtos e não se sobrepõem (um é nome, outro é etapa); ambos entram só quando aplicáveis |
| Histórico grava algo diferente do que foi enviado | `persistReply` recebe `bolhas.join('\n\n')` — é o mesmo texto |
| Harness valida um fechamento que produção não usa mais | `sim` e `replay` passam a chamar `bolhasDoTurno`, a mesma função da produção |

## Validação

- Testes puros novos: `test-fechamento` (ordem, texto exato, link, 4 bolhas, nenhuma > 350 chars),
  `test-retomada` (cada sinal, próxima etapa, não-injeção em conversa nova).
- Suíte existente inteira (`test-split`, `test-contato`, `test-conducao`, `test-anti-repeat`,
  `test-comprovante-core`, `test-agenda`, `test-followup`) verde.
- `test-triagem`: os cenários de handoff checam `enviarForm`, não o texto — seguem válidos. Entram dois
  cenários: retomada no dia seguinte (não repete valores) e paciente pedindo o valor de novo (repete).
- `sim-conversa passivo`: funil fecha e o fechamento sai nas 4 bolhas.
- `replay-conversas` com histórico real do Postgres: nenhuma reabertura com boas-vindas.
- `npm run build`.
- Antes do deploy: confirmar `app_config` vazio (senão o prompt do código não vale — armadilha #1 do
  `CONTEXTO-CAZULE.md`).
