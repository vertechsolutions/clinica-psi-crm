# Clinica Cazule · Assistente de IA no WhatsApp

Assistente de acolhimento e triagem da clinica no WhatsApp. Conversa como a recepcao
(acolhe, tira duvidas, informa valores, conduz ao agendamento) e monta uma ficha de
triagem por tras. Feito pela **Vertech**.

- **Frontend/tela de teste**: calibracao do raciocinio + chat de simulacao.
- **Webhook WhatsApp**: atende de verdade pelo numero da clinica.
- **Raciocinio ativo**: o que voce salva na tela passa a valer no WhatsApp (fica no banco).

## Stack

- **Next.js 16** (App Router) + React 19 + Tailwind 4
- **IA**: Google **Gemini 2.5 Flash** (`@google/genai`) - triagem estruturada
- **Banco**: **Postgres** (Railway) via `pg` - historico de conversa + ficha + config
- **Mensageria**: **WhatsApp Cloud API** (Graph API v25.0)
- **Deploy**: **Railway** (Railpack, auto-deploy no push pra `master`)

## Rodar local (so a tela de teste)

```bash
pnpm install
cp .env.example .env.local   # preencha GEMINI_API_KEY
pnpm dev                     # http://localhost:3000
```

Sem `DATABASE_URL` a tela de teste funciona (usa Gemini direto); so o webhook fica inativo.

Calibrar o raciocinio contra o Gemini real (cenarios de conversa):

```bash
npx tsx --env-file=.env.local scripts/test-triagem.ts
```

## Deploy no Railway

O servico `clinica-psi-crm` ja esta ligado ao repo `vertechsolutions/clinica-psi-crm`
(branch `master`, auto-deploy no push). Passos pra ligar o assistente:

### 1. Postgres

No projeto Railway: **New -> Database -> Add PostgreSQL**. Depois, no servico da app,
aba **Variables**, adicione a reference variable:

```
DATABASE_URL=${{Postgres.DATABASE_URL}}
```

(use a URL interna `*.railway.internal` - sem SSL, sem custo de egress). O schema e
criado sozinho no primeiro boot (`instrumentation.ts`).

### 2. Variaveis de ambiente (aba Variables)

| Variavel | Valor |
|---|---|
| `GEMINI_API_KEY` | key do Google AI Studio |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `WHATSAPP_TOKEN` | token permanente (System User) do app Meta |
| `WHATSAPP_PHONE_NUMBER_ID` | `1121282344409820` |
| `WHATSAPP_VERIFY_TOKEN` | uma senha que voce inventa (ver passo 3) |
| `WHATSAPP_APP_SECRET` | App Dashboard -> Settings -> Basic -> App Secret |
| `ADMIN_API_KEY` | senha forte que voce inventa (protege a tela e a exclusao de dados) |
| `RAILPACK_NODE_VERSION` | `22` (Next 16 exige Node >= 20.9) |

> **Importante (fail-closed):** sem `WHATSAPP_APP_SECRET` o webhook recusa toda
> mensagem; sem `ADMIN_API_KEY` os endpoints admin recusam acesso. Configure ambos.

Via CLI (opcional; da pra fazer tudo no dashboard):

```bash
railway link
railway variables --set "RAILPACK_NODE_VERSION=22"
railway variables --set "WHATSAPP_PHONE_NUMBER_ID=1121282344409820"
railway variables --set "WHATSAPP_VERIFY_TOKEN=<sua-senha>"
# ... demais vars
```

Build/start e healthcheck ja vem do `railway.json`.

### 3. Configurar o webhook no Meta

No **App Dashboard -> WhatsApp -> Configuration -> Webhook**:

- **Callback URL**: `https://<seu-dominio-railway>/api/whatsapp/webhook`
- **Verify token**: o mesmo valor de `WHATSAPP_VERIFY_TOKEN`
- Clique **Verify and save** (a Meta chama o `GET` e confere o token)
- Em **Webhook fields**, assine o campo **`messages`**

> O app precisa estar **publicado** (nao em modo dev) pra receber mensagens de
> producao. Em modo dev, so recebe webhooks de teste do dashboard.

### 4. Testar

Mande uma mensagem pro numero da clinica. Fluxo de teste sugerido: voce e o Jean
validam pelo numero; quando a Bruna aprovar o raciocinio pela tela, e so apontar o
numero dela. Pra ajustar o tom, edite na tela e clique **Salvar raciocinio** - vale
na hora no WhatsApp.

## Privacidade e dados (LGPD)

Sao dados sensiveis de saude (categoria especial). O que ja esta no codigo:

- **Retencao com prazo** (`src/lib/maintenance.ts`): triagem concluida e apagada
  apos **90 dias**; conversa incompleta apos **30 dias**. A limpeza roda no boot e
  a cada 24h.
- **Direito ao apagamento**: `DELETE /api/admin/patient?waId=<numero>` (com header
  `x-admin-key`) apaga tudo de um numero.
- **Endpoints sensiveis autenticados** (`/api/config`, `/api/admin/*`).
- **Em transito**: em producao use a `DATABASE_URL` **interna** do Railway
  (`*.railway.internal`) - rede privada, sem SSL exposto na internet.

Pendencias pra evoluir (fora do piloto): criptografia em repouso do campo `lead`
(dados clinicos), aviso de privacidade ao paciente no primeiro contato, e fila
duravel pro webhook (resiliencia a crash no meio do processamento).

## Como funciona por dentro

- `src/lib/default-prompt.ts` - o raciocinio padrao (persona, valores, fluxo, retencao).
- `src/lib/triagem.ts` - chamada ao Gemini + extracao da ficha (18 campos).
- `src/lib/conversation.ts` - historico, dedup, prompt ativo, orquestracao do turno.
- `src/lib/whatsapp.ts` - Graph API (enviar, marcar lida, "digitando", assinatura).
- `src/app/api/whatsapp/webhook/route.ts` - recebe e responde no WhatsApp.
- `src/app/api/config/route.ts` - get/set do raciocinio ativo.
- `src/lib/db.ts` + `src/lib/schema.ts` - Postgres (pool + tabelas).
