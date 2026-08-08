---
slug: camila-debounce-emoji-antibot
data: 2026-08-07
fase: PRD (design)
status: aprovado
gate: 2
aprovado_em: 2026-08-07
aprovado_por: Murilo
brief: docs/superpowers/specs/2026-08-07-camila-debounce-emoji-antibot-brief.md
---

# Leva 12 — Debounce, sem emoji e anti-bot (design)

> Fase 1 do ADP. Sintetiza o brief aprovado no Gate 1 (2026-08-07). Nível módulo e decisão — os caminhos exatos e a ordem de arquivos são das issues e da execução.

## Problema

Quem sofre é o lead na primeira mensagem da conversa. Ele manda "Oiii" e "Oii" em dois segundos e recebe o mesmo par de bolhas duplicado — a assinatura mais reconhecível de robô que existe num atendimento. A Bruna vende psicologia humanizada e a ilusão morre antes da triagem começar.

A causa não é o prompt: são dois `after()` concorrentes, um por POST do provider, que leem o mesmo histórico antes de qualquer resposta ser persistida e produzem a mesma saída. O guard anti-repetição existente não alcança isso porque compara contra o histórico carregado, idêntico nos dois turnos.

Junto: emoji nas mensagens (que a Bruna não quer) e nenhuma defesa contra um bot do outro lado, que faria as duas IAs conversarem em loop indefinidamente.

## Solução

Do ponto de vista do lead: ele escreve à vontade, em quantas mensagens quiser, e a Camila responde **uma vez**, considerando tudo que ele escreveu — como uma pessoa que lê a tela inteira antes de digitar. Sem emoji. E se do outro lado houver um robô repetindo a mesma coisa, a Camila para e chama um humano em vez de responder para sempre.

Do ponto de vista da equipe: nada de novo para operar, exceto um alerta a mais no WhatsApp quando um chat é pausado por suspeita de bot — com o número e o motivo, para reativar pelo painel em um clique se for engano.

## User Stories

1. Como lead, quero mandar "oi" e "queria saber o valor" em sequência, para receber **uma** resposta que trate o valor, e não duas respostas iguais.
2. Como lead que escreve devagar, quero partir meu relato em três mensagens, para a Camila responder ao relato inteiro e não à primeira frase solta.
3. Como lead, quero receber a resposta em um tempo que pareça humano, para não sentir nem a pressa do robô nem o abandono.
4. Como lead, quero que a conversa não tenha emoji, para o tom bater com o de uma clínica de psicologia.
5. Como lead que manda um comprovante junto de uma pergunta, quero que o comprovante continue sendo analisado, para o handoff acontecer como antes.
6. Como lead que reenvia a mesma mensagem porque o WhatsApp travou, quero continuar sendo atendido normalmente, para não ser confundido com um robô.
7. Como Bruna, quero ser avisada quando a Camila calar um chat por suspeita de bot, para não perder um lead real em silêncio.
8. Como Bruna, quero que meus alertas internos continuem com os emoji de marcador de campo, para bater o olho e achar a informação rápido.
9. Como equipe, quero reativar pelo painel um chat pausado por engano, para o lead voltar a ser atendido sem deploy.
10. Como sistema, quero que dois turnos concorrentes para o mesmo número nunca respondam os dois, para nenhuma duplicata escapar mesmo se o debounce falhar.
11. Como sistema, quero que um turno cujo processamento demorou além do teto não envie nada se outro turno já assumiu, para não duplicar quando o Gemini pendura.
12. Como sistema, quero que uma mensagem que chegou durante um turno em andamento seja respondida depois, e não descartada, para nenhum lead ficar sem resposta.
13. Como sistema, quero reprocessar no boot as conversas que ficaram sem resposta, para um restart no meio da janela de espera não engolir o atendimento.
14. Como sistema, quero que a varredura de boot respeite legado, allowlist e pausa, para não responder quem o webhook ao vivo calaria.
15. Como sistema, quero que a varredura de boot não ressuscite conversa antiga, para ninguém receber resposta de uma mensagem de ontem.
16. Como desenvolvedor, quero a janela de espera configurável, para o teste automatizado rodar em meio segundo em vez de oito.
17. Como desenvolvedor, quero um teste que dispare dois POST concorrentes, para a regressão desta correção ser detectada e não redescoberta em produção.
18. Como desenvolvedor, quero que o filtro de emoji preserve preço, acento e bullet, para a limpeza não corromper o conteúdo.
19. Como Murilo, quero um script que alinhe o prompt do banco com o do código, para a limpeza de emoji valer em produção mesmo com prompt salvo pelo painel.
20. Como lead cuja conversa está pausada, quero continuar tendo minhas mensagens gravadas sem resposta da IA, para a equipe ler o histórico completo — comportamento que **não** pode mudar.
21. Como conversa marcada como legado, quero continuar em silêncio total sem nem gravar, para a rede de segurança da virada seguir intacta — comportamento que **não** pode mudar.

## Critérios de aceitação

Herdados do brief e ligados aos seams.

| # | Critério | Seam | Story |
|---|---|---|---|
| CA1 | Dois POST concorrentes para o mesmo `wa_id` produzem **um** envio e uma chamada ao Gemini | HTTP (webhook real) | 1, 10 |
| CA2 | A resposta única contempla o conteúdo de todas as mensagens da rajada | HTTP | 2 |
| CA3 | Nenhum emoji chega ao lead por **nenhum** dos cinco pontos de saída; preço, acento e bullet sobrevivem | módulo puro | 4, 18 |
| CA4 | Três turnos idênticos consecutivos do lead pausam e alertam, sem chamar o Gemini | módulo puro + HTTP | 7 |
| CA5 | Dois claims concorrentes para o mesmo `wa_id` — inclusive número **novo, sem linha** em `wa_conversations` — só um vence | banco | 10 |
| CA6 | Mensagem chegada durante turno em andamento é respondida em um ciclo seguinte, nunca descartada | HTTP | 12 |
| CA7 | Turno que perdeu a titularidade aborta o envio em vez de duplicar | banco | 11 |
| CA8 | A varredura de boot acha conversa pendente **de lead novo sem linha em `wa_conversations`**, e respeita pausa, legado, allowlist e a janela de 30min | banco | 13, 14, 15 |
| CA9 | Os cenários existentes do teste HTTP (allowlist, eco, pausa, legado, dedup por `wamid`) continuam idênticos | HTTP | 20, 21 |
| CA10 | A suíte pura continua verde com os testes novos registrados | processo | — |

## Decisões de arquitetura

### Serialização: claim otimista com TTL, **não** advisory lock

O brief propôs `pg_try_advisory_lock`. Rejeitado no design por uma razão medida: advisory lock é por sessão, então segurar o turno inteiro (até duas chamadas ao Gemini, mais o envio de até três bolhas com 900ms entre elas) prenderia um client do pool por 10-15s. O pool é `max: 10` e é compartilhado com o app inteiro — dez conversas simultâneas em turno esgotariam o webhook, o painel admin e os crons juntos.

O claim otimista nunca segura conexão além da duração de uma query: um `INSERT ... ON CONFLICT DO UPDATE ... WHERE` que grava um prazo e um token, com `RETURNING` dizendo quem venceu. Sob READ COMMITTED, o segundo concorrente bloqueia no row lock e **reavalia o predicado** contra a versão commitada — não existe janela onde ambos passem. É o mesmo idioma que o `recordUserMessage` já usa em produção com o `ON CONFLICT (wamid) DO NOTHING RETURNING id`.

O `INSERT ... ON CONFLICT` (em vez de `UPDATE` puro) fecha um furo que só apareceu no design: **a linha em `wa_conversations` não existe para lead novo** — ela nasce no `upsertConversation`, que roda no `persistReply`, ou seja, depois da resposta. Um `UPDATE` não pegaria o primeiro contato, justamente o caso da print.

Snippet embutido porque a prosa não codifica a semântica com precisão:

```sql
INSERT INTO wa_conversations (wa_id, turno_ate, turno_token)
VALUES ($1, now() + make_interval(secs => $2), $3)
ON CONFLICT (wa_id) DO UPDATE
  SET turno_ate = now() + make_interval(secs => $2), turno_token = EXCLUDED.turno_token
WHERE wa_conversations.turno_ate IS NULL OR wa_conversations.turno_ate < now()
RETURNING wa_id
```

Convivência com os outros escritores da mesma PK: cada um escreve seu próprio conjunto de colunas e nenhum menciona as dos outros no `SET`, então o merge JSONB da ficha continua intocado.

O TTL (90s) é teto de segurança, não garantia — não há deadline duro em `computeReply` hoje. Por isso a titularidade é **reconferida imediatamente antes do envio**: se o token não bate mais, o turno aborta em silêncio em vez de duplicar.

### Módulos

| Módulo | Natureza | Responsabilidade |
|---|---|---|
| `emoji` | puro, novo | `semEmoji(texto)` — remove pictográficos e modificadores, preserva o resto |
| `anti-bot` | puro, novo | agrupa mensagens consecutivas do mesmo papel em turnos lógicos e decide se os N últimos turnos do lead são idênticos |
| `turno` | I/O, novo | buffer por `wa_id`, agendamento cancelável, e o ciclo de vida completo do turno |
| `turno-claim` | I/O, novo | claim, release e reconferência de titularidade — a peça de banco isolada |
| `boot-sweep` | I/O, novo | varredura de pendentes na subida |
| `allowlist` | puro, extraído | `atende(waId)` — movido do route sem mudar comportamento, porque a varredura de boot precisa do mesmo gate |

`turno` absorve a seção do webhook que hoje vai do `computeReply` até o `notifyTeam`, incluindo o backstop de comprovante e as funções de alerta. Não é só "buffer + agendamento": o debounce existe exatamente para decidir *quando* rodar essa sequência, e separar as duas coisas em módulos diferentes seria uma costura artificial. O `route` fica com o que é dele — roteação HTTP, gates de entrada e a fase por mensagem.

`anti-bot` é arquivo próprio, não um acréscimo ao `anti-repeat`: um guarda a **assistente** contra auto-repetição dentro de um turno e é consumido pelo wrapper de triagem; o outro avalia o **lead** ao longo de vários turnos e tem outra ação (pausar e alertar, não regenerar). Reusa a normalização de texto do `anti-repeat` por import, sem duplicar.

O agrupamento em turnos lógicos importa: uma rajada debounced gera N linhas em `wa_messages` mas é **um** turno. Sem agrupar, três mensagens iguais numa única rajada disparariam o anti-bot na primeira interação — exatamente o falso positivo que o desenho quer evitar.

### Corte do pipeline

**Por mensagem, imediato:** legado → pausa → extração de texto (transcrição e análise de anexo) → caminho de mídia não tratada → gravação com dedup por `wamid` → marcação de lida → acúmulo no buffer e reagendamento.

**Por turno, após o silêncio:** claim → histórico → anti-bot → `computeReply` → backstop de comprovante → bolhas com filtro de emoji → reconferência de titularidade → envio → persistência → handoff se for o caso → liberação do claim.

O que o buffer acumula por `wa_id`: o último `nome` e o último `comprovante` não-nulos da janela (o backstop e o alerta de equipe dependem dele), e o timer pendente.

**Falha de claim reagenda, não desiste.** Uma mensagem que chega durante um turno em andamento agenda um novo ciclo; quando ele dispara, o claim falha porque o turno anterior ainda roda. Desistir em silêncio ali perderia essa mensagem para sempre — nada mais a reprocessaria, já que a varredura só roda no boot. A reação correta é reagendar outro ciclo de debounce, com teto de tentativas.

**A marcação de lida fica onde está, por mensagem.** No provider ativo (Z-API) ela só marca lida — o "digitando" viaja no parâmetro de envio e só aparece quando a resposta sai. No provider Meta o indicador expira em 25s, então chamar por mensagem apenas o renova durante a espera. O risco de "digitando piscando" levantado no brief não existe.

**O fallback de mídia não tratada fica fora do buffer.** Ele nunca chamou o modelo e nunca teve o problema de duplicação. A sobreposição rara (sticker seguido de texto gera duas respostas) já acontece hoje, idêntica, sem debounce nenhum — não é regressão desta leva, e bufferizar acoplaria dois caminhos hoje independentes por ganho cosmético.

### Emoji: cinco pontos de saída, não um

O brief dizia que o ponto único de decisão de saída cobriria tudo. O design confirmou que **não**. Os pontos que chegam ao lead:

1. A decisão de bolhas do turno — resposta do modelo e as bolhas oficiais de fechamento. É o choke point, mas não é o único.
2. e 3. Os dois fallbacks de mídia, enviados direto sem passar pelo modelo.
4. O fallback de falha temporária.
5. **A mensagem de reengajamento do cron de follow-up** — dispara sozinha a cada hora, fora do fluxo do webhook inteiro. Não estava no brief.

Todos recebem o filtro no ponto de envio. A mensagem de anexo inválido não precisa: ela vira a resposta do turno e já passa pela decisão de bolhas.

Correção ao brief: o `⚠️` do módulo de comprovante **não vai ao lead** — está no marcador gravado no histórico para realimentar o modelo. Limpar é cosmético, não fecha vazamento.

Além do filtro, o prompt é limpo (a instrução que manda o modelo usar emoji em listas, e os quatro exemplos que demonstram emoji), com bump da versão. O exemplo que mostra o que o *paciente* manda fica intacto. O script de sincronização alinha o prompt salvo no banco, rodado manualmente.

O texto persistido é o **já filtrado** — o histórico grava o que o paciente de fato recebeu.

### Varredura de boot

Parte das mensagens, não das conversas: um lead cujo processo morreu antes da primeira resposta nunca teve linha em `wa_conversations`, e é justamente o caso mais grave. Critério: última mensagem do lead mais recente que a última da assistente, dentro de 30 minutos, conversa não pausada. Cada número encontrado revalida legado e allowlist antes de reprocessar — o gate tem que ser o mesmo do webhook ao vivo. Sequencial, para não disparar uma rajada de chamadas ao modelo bem no health check da subida. Dispara sem bloquear o boot.

Limitação aceita: nesse caminho não há análise de anexo fresca, então o backstop de comprovante não protege um turno que era de comprovante. O alerta de equipe já tem o caso "recebido em turno anterior — conferir na conversa".

### Schema

Duas colunas novas em `wa_conversations` (prazo e token do turno), pelo padrão idempotente e cumulativo que o projeto já usa — sem migration runner, aplicado no boot.

### Dependências entre as peças

O filtro de emoji e o anti-bot são folhas, sem dependência. O claim depende só do schema. O turno depende do filtro, do anti-bot, do claim e do histórico exportado. O webhook depende do turno. A varredura depende do turno, da allowlist e do legado. A limpeza do prompt e o script de sincronização são independentes de tudo.

## Novas adoções

Nenhuma biblioteca, MCP ou ferramenta nova. A feature usa exclusivamente o que o projeto já tem: `pg` cru, `setTimeout` do Node no processo long-running, e as próprias funções de estado e envio existentes. As técnicas adotadas (debounce cancelável por chave, claim otimista com TTL, filtro por propriedade Unicode) são padrões, não dependências.

Duas variáveis de ambiente novas, ambas com default: a janela de debounce (8000ms) e nada mais — o TTL do claim e a janela da varredura são constantes em código, por serem tetos de segurança e não parâmetros de negócio.

## Decisões de teste

Um bom teste aqui verifica **o que o lead recebe** e **o que o banco registra**, nunca como o buffer está implementado. Ninguém testa o `Map` interno nem a existência do timer.

**Seams, do mais alto para o mais baixo:**

- **HTTP no webhook real** (seam preferido, já existe no projeto e é onde CA1, CA2, CA6 e CA9 vivem). O arcabouço existente sobe o app de verdade e bate no endpoint, mas **todos os cenários atuais são sequenciais** — não existe nenhum disparo concorrente no repositório hoje. É a lacuna que esta leva fecha. Exige a janela de debounce configurável, senão cada cenário custa oito segundos.
- **Módulo puro** (CA3, CA4): filtro de emoji e detecção de bot, com asserções diretas. Entram na suíte pura.
- **Banco** (CA5, CA7, CA8): claim concorrente e varredura, contra o banco de teste. Fora da suíte pura, como os demais testes que precisam de conexão.

**Prior art:** a suíte tem quinze scripts puros no mesmo formato — asserções de `node:assert`, sem framework. O teste de fechamento é o modelo mais próximo para o filtro de emoji (texto entra, texto sai). O teste de anti-repetição é o modelo para o anti-bot.

**Casos que os testes puros precisam cobrir explicitamente:** preço com cifrão e vírgula intacto; acentuação portuguesa intacta; bullet intacto; sequência com ZWJ removida por inteiro; keycap virando o dígito puro; espaço órfão no meio da frase colapsado sem destruir a quebra dupla que separa bolhas; três turnos idênticos detectados; três mensagens idênticas na **mesma rajada** *não* detectadas; reenvio do provider não detectado.

## Fora de escopo

Herdado do brief, sem mudança: debounce adaptativo por análise da última frase; auto-retomada de conversa pausada; processar batches com mais de uma mensagem no payload; migrar o buffer para tabela com polling; remover emoji dos alertas internos; alerta quando paciente responde após handoff; detecção de bot por cadência ou volume.

Acrescentado no design: deadline duro no `computeReply` (a reconferência de titularidade já cobre a consequência); bufferizar o fallback de mídia não tratada; varredura periódica de pendentes além da de boot.

## Riscos e questões em aberto

1. **Turno pendurado além do TTL** — mitigado pela reconferência de titularidade antes do envio, não pelo TTL sozinho. Sem deadline duro no modelo, é o que garante que não haja envio duplo.
2. **Restart dentro da janela** — reduzido pela varredura de boot, não eliminado: o intervalo entre o crash e a subida continua existindo.
3. **Backstop de comprovante cego na varredura de boot** — exige crash exatamente num turno de comprovante. A rede que sobra é o alerta de conferência manual.
4. **Falso positivo de bot** com lead que cola a mesma pergunta em três turnos separados — a conversa pausa, mas o alerta chega à equipe e a reativação é manual e imediata.
5. **Prompt do banco** — enquanto a sincronização não for rodada, o modelo segue instruído a gerar emoji que o filtro descarta. Ação manual.
6. **Não consta** se a Z-API expõe evento de digitação do lead, o que permitiria encerrar a janela assim que ele parasse.
7. **Não consta** se algum provider sinaliza no webhook que o outro lado é uma Business API, o que seria um detector melhor que a heurística de repetição.
8. **Pool de dez conexões** continua sendo o teto do app. O claim não o consome além de uma query, mas o volume de turnos simultâneos ainda vale observação depois do deploy.

## Notas

A leva reduz custo de modelo em vez de aumentar: uma rajada de três mensagens que hoje gera três turnos (cada um com até duas chamadas) passa a gerar um.

O efeito colateral de pausar por bot já está correto sem código adicional — a busca de leads frios do follow-up exclui conversas pausadas, então um chat calado por suspeita de bot não recebe reengajamento.

A janela de espera de dois segundos que existe no tratamento de eco serve a outro propósito (distinguir o eco do próprio envio) e não deve ser reaproveitada nem confundida com o debounce.
