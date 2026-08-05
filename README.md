# Clínica Cazule · Assistente de IA no WhatsApp

Assistente de acolhimento e triagem da clínica no WhatsApp. Conversa como a recepção
(acolhe, tira dúvidas, informa valores, conduz ao agendamento) e monta uma ficha de
triagem por trás. Feito pela **Vertech**.

- **Frontend/tela de teste**: calibração do raciocínio + chat de simulação.
- **Webhook WhatsApp**: atende de verdade pelo número da clínica.
- **Raciocínio ativo**: o que você salva na tela passa a valer no WhatsApp (fica no banco).

## Stack

- **Next.js 16** (App Router) + React 19 + Tailwind 4
- **IA**: Google **Gemini 2.5 Flash** (`@google/genai`) — triagem estruturada
- **Banco**: **Postgres** (Railway) via `pg` — histórico de conversa + ficha + config
- **Mensageria**: **WhatsApp Cloud API** (Graph API v25.0)
- **Deploy**: **Railway** (Railpack, auto-deploy no push pra `master`)

## Rodar local (só a tela de teste)

```bash
pnpm install
cp .env.example .env.local   # preencha GEMINI_API_KEY
pnpm dev                     # http://localhost:3000
```

Sem `DATABASE_URL` a tela de teste funciona (usa Gemini direto); só o webhook fica inativo.

Calibrar o raciocínio contra o Gemini real (cenários de conversa):

```bash
npx tsx --env-file=.env.local scripts/test-triagem.ts   # 10 cenários fixos (regressão)
npx tsx --env-file=.env.local scripts/sim-conversa.ts   # simulação multi-turno (3 personas)
npx tsx scripts/test-split.ts                           # unit: bolhas de mensagem
npx tsx scripts/test-agenda.ts                          # unit: parsers/resumo da agenda
npx tsx scripts/test-followup.ts                        # unit: janela de 24h do follow-up
```

## Deploy no Railway

O serviço `clinica-psi-crm` já está ligado ao repo `vertechsolutions/clinica-psi-crm`
(branch `master`, auto-deploy no push). Passos pra ligar o assistente:

### 1. Postgres

No projeto Railway: **New → Database → Add PostgreSQL**. Depois, no serviço da app,
aba **Variables**, adicione a reference variable:

```
DATABASE_URL=${{Postgres.DATABASE_URL}}
```

(use a URL interna `*.railway.internal` — sem SSL, sem custo de egress). O schema é
criado sozinho no primeiro boot (`instrumentation.ts`).

### 2. Variáveis de ambiente (aba Variables)

| Variável | Valor |
|---|---|
| `GEMINI_API_KEY` | key do Google AI Studio |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `WA_PROVIDER` | `zapi` (default) ou `meta` — qual transporte entrega as mensagens |
| `ZAPI_INSTANCE_ID` / `ZAPI_INSTANCE_TOKEN` | da instância no painel da Z-API (`WA_PROVIDER=zapi`) |
| `ZAPI_CLIENT_TOKEN` | token de segurança da conta Z-API (aba Segurança) |
| `ZAPI_WEBHOOK_SECRET` | segredo que **você** inventa; vai na query da URL do webhook (ver passo 3) |
| `WA_LEGADO_CHAVE` | string aleatória longa: chave do HMAC dos telefones da lista de legado (ver passo 5). Trocar invalida a lista e **cala** a IA |
| `WA_ALLOWLIST` | trava de estreia: só esses números falam com a IA. **Vazia = atende todo mundo** (o normal, depois do passo 5) |
| `WHATSAPP_TOKEN` | token permanente (System User) do app Meta (`WA_PROVIDER=meta`) |
| `WHATSAPP_PHONE_NUMBER_ID` | ID do número da clínica (WhatsApp Manager) — muda se o número mudar |
| `WHATSAPP_VERIFY_TOKEN` | uma senha que você inventa (ver passo 3) |
| `WHATSAPP_APP_SECRET` | App Dashboard → Settings → Basic → App Secret |
| `ADMIN_API_KEY` | senha forte que você inventa (protege a tela e a exclusão de dados) |
| `RAILPACK_NODE_VERSION` | `22` (Next 16 exige Node ≥ 20.9) |
| `FORM_URL` | link público do Google Forms de triagem (sem ele o `{FORM_URL}` vaza literal) |
| `NOTIFY_ALERT_NUMBERS` | números que recebem o alerta do handoff (E.164 sem `+`, vírgula) |
| `GEMINI_TRANSCRIBE_MODEL` | `gemini-2.5-flash-lite` (transcrição de áudio, mais barato — opcional) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | JSON da service account (uma linha) — agenda no Sheets (opcional) |
| `AGENDA_SHEET_ID` | id da planilha `Cazule — Agenda` no Google Sheets (opcional) |
| `FOLLOWUP_ENABLED` | `false` por padrão — reengajamento proativo é **opt-in** |
| `FOLLOWUP_TEMPLATE_NAME` | template Meta p/ reengajar fora da janela de 24h — **só** com `WA_PROVIDER=meta` |

> Sem `GOOGLE_SERVICE_ACCOUNT_JSON`/`AGENDA_SHEET_ID` o app funciona normal — a Camila
> só não enxerga a agenda (diz que vai confirmar horário com a equipe). Diagnóstico da
> integração: `npx tsx --env-file=.env.local scripts/test-sheets-live.ts`.

> **Importante (fail-closed):** o webhook recusa toda mensagem sem o segredo do
> provider ativo — `ZAPI_WEBHOOK_SECRET` (zapi) ou `WHATSAPP_APP_SECRET` (meta).
> Sem `ADMIN_API_KEY` os endpoints admin recusam acesso. Configure os dois.

Via CLI (opcional; dá pra fazer tudo no dashboard):

```bash
railway link
railway variables --set "RAILPACK_NODE_VERSION=22"
railway variables --set "WHATSAPP_PHONE_NUMBER_ID=<id do WhatsApp Manager>"
railway variables --set "WHATSAPP_VERIFY_TOKEN=<sua-senha>"
# ... demais vars
```

Build/start e healthcheck já vêm do `railway.json`.

### 3. Configurar o webhook

#### Z-API (`WA_PROVIDER=zapi`) — o caminho atual

1. Crie a instância em https://app.z-api.io e anote **ID**, **Token** e o
   **Client-Token** (aba Segurança).
2. Em **Instância → Editar**, leia o **QR code** com o celular da clínica
   (WhatsApp → Aparelhos conectados). O número continua funcionando no celular:
   a Camila e a Bruna dividem a mesma linha.
3. Em **Webhooks**, configure o **"Ao receber"** com a URL do app **incluindo o
   segredo na query**:

   ```
   https://<seu-dominio-railway>/api/whatsapp/webhook?s=<ZAPI_WEBHOOK_SECRET>
   ```

   Marque a opção de **receber também as mensagens enviadas pelo próprio
   número** — é o que faz a IA se calar sozinha quando a Bruna responde pelo
   celular. Os outros webhooks (status, entrega) podem ficar desligados: são
   ignorados.

> A Z-API **não assina** o webhook (o Client-Token protege só as chamadas que o
> app faz pra ela). O `?s=` é a autenticação: trate como senha, não mande por
> canal público, e troque a variável se vazar.

#### Meta (`WA_PROVIDER=meta`)

No **App Dashboard → WhatsApp → Configuration → Webhook**:

- **Callback URL**: `https://<seu-dominio-railway>/api/whatsapp/webhook`
- **Verify token**: o mesmo valor de `WHATSAPP_VERIFY_TOKEN`
- Clique **Verify and save** (a Meta chama o `GET` e confere o token)
- Em **Webhook fields**, assine o campo **`messages`**

> O app precisa estar **publicado** (não em modo dev) pra receber mensagens de
> produção. Em modo dev, só recebe webhooks de teste do dashboard.

### 4. Testar

Antes de qualquer coisa, rode o diagnóstico (só leitura, não fala com ninguém):

```bash
npx tsx --env-file=.env.local scripts/diagnostico-zapi.ts
```

Ele confere se a instância está conectada, se o número pareado é o certo, se o
webhook aponta pra cá com o segredo certo, se o eco `fromMe` está ligado e quantos
chats o aparelho já sincronizou.

Depois mande uma mensagem pro número da clínica. Pra ajustar o tom, edite na tela e
clique **Salvar raciocínio** — vale na hora no WhatsApp.

### 5. Separar as conversas antigas das novas

O número é o WhatsApp profissional da Bruna e **já tinha conversas em andamento**
quando a Camila entrou: pacientes que ela atende à mão, leads antigos, contato
pessoal. Sem separar, esvaziar a `WA_ALLOWLIST` faria a IA cair em cima de todas de
uma vez.

A lista de **legado** guarda o hash (nunca o telefone) de quem já era dela. Ordem:

1. Deploy com a `WA_ALLOWLIST` ainda preenchida e a `WA_LEGADO_CHAVE` setada. A
   tabela vazia deixa o filtro inerte — nada muda de comportamento. Daqui em
   diante, toda vez que a Bruna escreve pra um número que a Camila nunca atendeu,
   aquele número entra na lista sozinho.
2. Importe **a seco** (`"dry":true`), duas vezes com algumas horas de intervalo. Se
   o total mal mudar, o aparelho terminou de sincronizar.
3. Grave (`"dry":false,"esperado":<total do DRY>`). A gravação recusa um delta
   grande de propósito — é o que impede importar um aparelho pela metade.
4. Confira com a Bruna: `GET /api/admin/legado?waId=<número de um paciente antigo>`
   tem que responder `legado: true`.
5. **Só então** esvazie a `WA_ALLOWLIST`. A Camila abre pra leads novos.

Se ela falar onde não devia, **a Bruna só precisa responder pelo celular** — o eco
pausa a IA naquele número em segundos, sem depender de ninguém.

## Privacidade e dados (LGPD)

São dados sensíveis de saúde (categoria especial). O que já está no código:

- **Retenção com prazo** (`src/lib/maintenance.ts`): triagem concluída é apagada
  após **90 dias**; conversa incompleta após **30 dias**. A limpeza roda no boot e
  a cada 24h.
- **Direito ao apagamento**: `DELETE /api/admin/patient?waId=<numero>` (com header
  `x-admin-key`) apaga tudo de um número. A resposta traz `legadoRestante: true`
  quando aquele número também está na lista de legado (ver abaixo) — o expurgo só
  fica completo com `DELETE /api/admin/legado?waId=<numero>`.
- **Lista de legado** (`wa_legado`): guarda **só o HMAC** do telefone de quem já era
  atendido à mão pela Bruna — sem nome, sem telefone em claro, sem conteúdo, com a
  data truncada no dia. É lista de *supressão*: existe pra que a IA **não** trate
  aquelas pessoas, e por isso fica de fora da rotina de retenção (expirar a linha
  devolveria essas conversas pra Camila em silêncio). A chave do HMAC mora em env,
  nunca no banco: um dump não revela a agenda da Bruna.
- **Endpoints sensíveis autenticados** (`/api/config`, `/api/admin/*`).
- **Em trânsito**: em produção use a `DATABASE_URL` **interna** do Railway
  (`*.railway.internal`) — rede privada, sem SSL exposto na internet.

Pendências pra evoluir (fora do piloto): criptografia em repouso do campo `lead`
(dados clínicos), aviso de privacidade ao paciente no primeiro contato, e fila
durável pro webhook (resiliência a crash no meio do processamento).

## Como funciona por dentro

- `src/lib/default-prompt.ts` — o raciocínio padrão (persona, valores, fluxo, retenção).
- `src/lib/triagem.ts` — chamada ao Gemini + extração da ficha (18 campos).
- `src/lib/conversation.ts` — histórico, dedup, prompt ativo, agenda, orquestração do turno.
- `src/lib/whatsapp.ts` — Graph API (enviar texto/sequência/template, lida, "digitando", assinatura, mídia).
- `src/lib/split-message.ts` — quebra a resposta em 2–3 bolhas de WhatsApp.
- `src/lib/transcribe.ts` — transcrição de áudio (Gemini multimodal).
- `src/lib/agenda-core.ts` + `src/lib/sheets.ts` — agenda da clínica no Google Sheets
  (parsers puros + Service Account com cache e fallback gracioso).
- `src/lib/followup.ts` — reengajamento proativo de leads frios (opt-in, adiado no piloto).
- `src/app/api/whatsapp/webhook/route.ts` — recebe e responde no WhatsApp.
- `src/app/api/config/route.ts` — get/set do raciocínio ativo.
- `src/lib/db.ts` + `src/lib/schema.ts` — Postgres (pool + tabelas).
