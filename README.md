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
npx tsx --env-file=.env.local scripts/test-triagem.ts
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
| `WHATSAPP_TOKEN` | token permanente (System User) do app Meta |
| `WHATSAPP_PHONE_NUMBER_ID` | `1121282344409820` |
| `WHATSAPP_VERIFY_TOKEN` | uma senha que você inventa (ver passo 3) |
| `WHATSAPP_APP_SECRET` | App Dashboard → Settings → Basic → App Secret |
| `ADMIN_API_KEY` | senha forte que você inventa (protege a tela e a exclusão de dados) |
| `RAILPACK_NODE_VERSION` | `22` (Next 16 exige Node ≥ 20.9) |

> **Importante (fail-closed):** sem `WHATSAPP_APP_SECRET` o webhook recusa toda
> mensagem; sem `ADMIN_API_KEY` os endpoints admin recusam acesso. Configure ambos.

Via CLI (opcional; dá pra fazer tudo no dashboard):

```bash
railway link
railway variables --set "RAILPACK_NODE_VERSION=22"
railway variables --set "WHATSAPP_PHONE_NUMBER_ID=1121282344409820"
railway variables --set "WHATSAPP_VERIFY_TOKEN=<sua-senha>"
# ... demais vars
```

Build/start e healthcheck já vêm do `railway.json`.

### 3. Configurar o webhook no Meta

No **App Dashboard → WhatsApp → Configuration → Webhook**:

- **Callback URL**: `https://<seu-dominio-railway>/api/whatsapp/webhook`
- **Verify token**: o mesmo valor de `WHATSAPP_VERIFY_TOKEN`
- Clique **Verify and save** (a Meta chama o `GET` e confere o token)
- Em **Webhook fields**, assine o campo **`messages`**

> O app precisa estar **publicado** (não em modo dev) pra receber mensagens de
> produção. Em modo dev, só recebe webhooks de teste do dashboard.

### 4. Testar

Mande uma mensagem pro número da clínica. Fluxo de teste sugerido: você e o Jean
validam pelo número; quando a Bruna aprovar o raciocínio pela tela, é só apontar o
número dela. Pra ajustar o tom, edite na tela e clique **Salvar raciocínio** — vale
na hora no WhatsApp.

## Privacidade e dados (LGPD)

São dados sensíveis de saúde (categoria especial). O que já está no código:

- **Retenção com prazo** (`src/lib/maintenance.ts`): triagem concluída é apagada
  após **90 dias**; conversa incompleta após **30 dias**. A limpeza roda no boot e
  a cada 24h.
- **Direito ao apagamento**: `DELETE /api/admin/patient?waId=<numero>` (com header
  `x-admin-key`) apaga tudo de um número.
- **Endpoints sensíveis autenticados** (`/api/config`, `/api/admin/*`).
- **Em trânsito**: em produção use a `DATABASE_URL` **interna** do Railway
  (`*.railway.internal`) — rede privada, sem SSL exposto na internet.

Pendências pra evoluir (fora do piloto): criptografia em repouso do campo `lead`
(dados clínicos), aviso de privacidade ao paciente no primeiro contato, e fila
durável pro webhook (resiliência a crash no meio do processamento).

## Como funciona por dentro

- `src/lib/default-prompt.ts` — o raciocínio padrão (persona, valores, fluxo, retenção).
- `src/lib/triagem.ts` — chamada ao Gemini + extração da ficha (18 campos).
- `src/lib/conversation.ts` — histórico, dedup, prompt ativo, orquestração do turno.
- `src/lib/whatsapp.ts` — Graph API (enviar, marcar lida, "digitando", assinatura).
- `src/app/api/whatsapp/webhook/route.ts` — recebe e responde no WhatsApp.
- `src/app/api/config/route.ts` — get/set do raciocínio ativo.
- `src/lib/db.ts` + `src/lib/schema.ts` — Postgres (pool + tabelas).
