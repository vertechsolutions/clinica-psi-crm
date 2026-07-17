# Camila IA — Pacote de Melhorias (8 goals) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **NOTA DE ATUALIZAÇÃO (17/07, pós-execução):** a agenda evoluiu pra v2 depois deste plano —
> `resumoDisponibilidade(data, {hoje})` lista TODAS as psicólogas com tags
> individual/casal/13+ e filtra reservas passadas (o parâmetro `{modalidade}` descrito nas
> seções abaixo foi substituído). O follow-up virou OPT-IN (`FOLLOWUP_ENABLED=true`
> explícito) e o canal dominante é o template Meta. Fonte da verdade: `src/lib/agenda-core.ts`
> e `src/lib/followup.ts`.

**Goal:** Completar e ampliar a assistente Camila (WhatsApp da Clínica Cazule) cobrindo as 8 demandas da Bruna: áudio, agenda via Google Sheets, proatividade/follow-up, form pós-pagamento, planilha-banco, FAQ, respostas curtas em múltiplas mensagens, e desligar a IA no handoff — com uma rodada de testes dirigida por Gemini (paciente/lead simulados), revisão por modelo Fable e correções executadas em Opus/ultracode.

**Architecture:** Next.js 16 (App Router, `--webpack`) rodando no Railway; webhook do WhatsApp Cloud API processa mensagens em `after()`, chama `computeReply()` → `runTriagem()` (Gemini 2.5 Flash, saída JSON estruturada) e persiste no Postgres (`pg`). As melhorias entram como **módulos pequenos e focados**: entrega em múltiplas bolhas (`split-message`), leitura da agenda por Service Account (`sheets` + `agenda-core` puro), follow-up proativo por cron in-process (`followup`), tudo com *fallback gracioso* quando a env var correspondente não está configurada (o app nunca quebra por falta de credencial).

**Tech Stack:** TypeScript, Next.js 16, `@google/genai` (Gemini), `pg` (Postgres), WhatsApp Cloud API v25.0 (Graph, via `fetch`), `google-auth-library` (JWT da Service Account, novo), testes como scripts `tsx` + `node:assert`.

---

## Decisões travadas (Gate 1 — aprovadas pelo Murilo em 2026-07-17)

1. **Google Sheets via Service Account** — `google-auth-library` (JWT) + REST da Sheets API (`fetch`). Sem depender do mailbox `camilaia@` estar pronto: basta compartilhar a planilha com o e-mail da service account. (Escolhido `google-auth-library` em vez de `googleapis` pra manter o bundle leve no build do Railway.)
2. **Follow-up completo** — cron reengaja leads frios; dentro de 24h manda a mensagem 7 do FAQ livre, após 24h usa **template aprovado na Meta**. Gate de segurança por env (`FOLLOWUP_ENABLED`, `FOLLOWUP_TEMPLATE_NAME`).
3. **Escopo total** — completar as goals já parciais (config + robustez) E construir as 3 lacunas reais (Sheets, proatividade, split de mensagens), fechando as 8.

**Defaults assumidos** (não perguntados): pagamento continua **manual** (comprovante = imagem/anexo dispara handoff, já implementado); o e-mail da IA usa o nome **`camilaia@vertechsolucoes.com.br`** (instrução mais recente do Murilo; o `CONTEXTO-CAZULE.md` cita `camila@` — alinhar depois).

## Estado por goal (baseline antes deste plano)

| # | Goal | Baseline | Trabalho aqui |
|---|------|----------|----------------|
| 1 | Interpretar áudio | ✅ feito (`transcribe.ts`, `downloadMedia`, webhook) | Task 4.1 (robustez `audio.voice`) |
| 2 | Agenda no Drive | ❌ greenfield | Fase 2 |
| 3 | Proatividade/follow-up | ❌ greenfield | Fase 3 |
| 4 | Form pós-pagamento | ✅ feito (`enviarForm`+handoff) | Task 0.1 + 6.x (setar `FORM_URL`) |
| 5 | Planilha modelo + email/Drive-banco | ⚠️ modelo `.xlsx` existe | Fase 2 + Runbook R1/R2 |
| 6 | FAQ da Bruna | ✅ feito (19 P&R no prompt) | — (nenhum) |
| 7 | Respostas curtas / múltiplas msgs | ⚠️ só instrução no prompt | Fase 1 (split real) |
| 8 | Desligar IA após form | ✅ feito (`pausada=true`) | Task 0.1 + 6.x (setar `NOTIFY_ALERT_NUMBERS`) |

---

## File Structure

**Novos arquivos:**
- `src/lib/split-message.ts` — função pura `splitReply(text)` → `string[]` (quebra a resposta em 1–3 bolhas de WhatsApp). Responsabilidade única: decidir onde cortar.
- `src/lib/agenda-core.ts` — funções puras: parsers das abas (`parsePsicologas/parseGrade/parseAgenda`) + `resumoDisponibilidade(data, opts)` → string injetável no prompt. Zero I/O (100% testável com fixtures).
- `src/lib/sheets.ts` — I/O: auth por Service Account (JWT) + `fetch` batchGet da Sheets API + cache TTL; expõe `agendaContexto()` que nunca lança (retorna `''` em falha/desconfigurado).
- `src/lib/followup.ts` — proatividade: predicados puros (`decideChannel`, `shouldFollowup`) + `runFollowup()` (query + envio) + `scheduleFollowup()`.
- `scripts/test-split.ts`, `scripts/test-agenda.ts`, `scripts/test-followup.ts` — testes unitários (tsx + `node:assert`).
- `scripts/sim-conversa.ts` — harness da rodada de testes: Gemini encena paciente/lead multi-turno contra `runTriagem`.

**Arquivos modificados:**
- `src/lib/whatsapp.ts` — `+sendTextSequence()`, `+sendTemplate()`, `+sleep`.
- `src/app/api/whatsapp/webhook/route.ts` — troca `sendText` único por `splitReply`+`sendTextSequence`.
- `src/lib/conversation.ts` — injeta `agendaContexto()` no system prompt do `computeReply`.
- `src/lib/schema.ts` — `+ADD COLUMN followup_count, followup_last_at`.
- `src/lib/instrumentation.ts` (na verdade `src/instrumentation.ts`) — agenda `scheduleFollowup()`.
- `src/lib/default-prompt.ts` — 1 linha no Passo 2 (usar a agenda do contexto) + regra explícita de múltiplas mensagens + `PROMPT_VERSION` bump.
- `.env.example` — documenta as env vars novas.
- `package.json` — `+google-auth-library`.

**Convenção de teste do repo (siga):** não há jest/vitest. Testes puros = script `tsx` com `node:assert` que dá `process.exit(1)` em falha. Rodar: `npx tsx scripts/test-*.ts`. Testes que tocam Gemini leem `.env.local` (como `scripts/test-triagem.ts`).

---

## Runbook de pré-requisitos (operacional — Murilo executa, com apoio do agente)

> Estes passos criam credenciais externas. O código funciona sem eles (fallback gracioso), mas as goals 2/3/5 só ficam “live” depois. Fazer em paralelo às fases de código.

### R1 — Service Account + planilha no Drive (goals 2, 5)
- [ ] No Google Cloud Console: criar projeto `cazule-camila` → **Enable APIs**: “Google Sheets API”.
- [ ] IAM → Service Accounts → criar `camila-sheets@cazule-camila.iam.gserviceaccount.com` → Keys → **Add key → JSON** (baixa o `key.json`).
- [ ] Subir a planilha modelo pro Drive **como Google Sheet**: no Drive de `camilaia@vertechsolucoes.com.br` (ou do Murilo), `Novo → Upload` de `planilha-horarios-modelo.xlsx` → abrir com Google Sheets → `Arquivo → Salvar como Planilhas Google`. Renomear para `Cazule — Agenda`.
- [ ] **Compartilhar** essa planilha com o `client_email` da service account (papel: Leitor).
- [ ] Copiar o **spreadsheetId** da URL (`/spreadsheets/d/<ID>/edit`).
- [ ] Guardar `key.json` e o ID para a Task 6.2 (setar `GOOGLE_SERVICE_ACCOUNT_JSON` e `AGENDA_SHEET_ID` no Railway). O JSON vai como string única; o código normaliza `\n` do `private_key`.
- [ ] Subir também o FAQ (`Documento sem título (8).pdf`) e o pipeline de atendimento numa pasta `Cazule — Camila (banco)` no mesmo Drive (Drive-como-banco documental; consumido por humanos e como fonte da verdade do prompt).

### R2 — Template de reengajamento na Meta (goal 3)
- [ ] WhatsApp Manager → Message Templates → **Create template** → categoria **Marketing** (reengajamento não se qualifica como Utility) → idioma `Português (BR)`.
- [ ] Nome: `retomada_atendimento`. Corpo (sem variáveis, aprovação mais fácil):
  > Olá! Não tive seu retorno e estou passando para saber se você ainda deseja agendar sua primeira sessão na Cazule. Podemos continuar o atendimento?
- [ ] Após **aprovado**, setar `FOLLOWUP_TEMPLATE_NAME=retomada_atendimento` no Railway (Task 6.2). Sem isso, o cron só reengaja dentro da janela de 24h e loga um aviso para os leads fora dela.

---

## Fase 0 — Fundações (config + dependência)

### Task 0.1: Documentar env vars novas no `.env.example`

**Files:**
- Modify: `C:\dev\clinica-psi-crm\.env.example`

- [ ] **Step 1: Adicionar o bloco ao final do arquivo**

Acrescente ao fim de `.env.example`:

```bash

# ── Formulário + handoff (goals 4, 8) ──────────────────────────────
# Link do Google Forms de triagem. Sem ele, {FORM_URL} vaza como placeholder.
FORM_URL=
# Números que recebem o alerta quando o form é enviado (E.164 sem "+", vírgula).
NOTIFY_ALERT_NUMBERS=5527981178233,5549999551051
# Modelo Gemini p/ transcrição de áudio (mais barato). Cai no GEMINI_MODEL se vazio.
GEMINI_TRANSCRIBE_MODEL=gemini-2.5-flash-lite

# ── Agenda no Google Sheets (goals 2, 5) ───────────────────────────
# JSON da Service Account (uma linha). Sem isto, a Camila não lê a agenda (fallback).
GOOGLE_SERVICE_ACCOUNT_JSON=
# ID da planilha "Cazule — Agenda" (da URL /spreadsheets/d/<ID>/edit).
AGENDA_SHEET_ID=

# ── Follow-up proativo (goal 3) ────────────────────────────────────
# Liga/desliga o cron de reengajamento. "false" desativa por completo.
FOLLOWUP_ENABLED=true
# Nome do template aprovado na Meta p/ reengajar fora da janela de 24h.
FOLLOWUP_TEMPLATE_NAME=
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "chore: documenta env vars de agenda, follow-up e handoff"
```

### Task 0.2: Instalar `google-auth-library`

**Files:**
- Modify: `C:\dev\clinica-psi-crm\package.json` (via gerenciador)

- [ ] **Step 1: Instalar (pnpm — o repo usa pnpm-lock.yaml)**

Run: `pnpm add google-auth-library`
Expected: `dependencies` ganha `google-auth-library`, `pnpm-lock.yaml` atualizado.

- [ ] **Step 2: Sanity de build**

Run: `pnpm build`
Expected: build passa (0 erros de tipo).

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: add google-auth-library (agenda via Service Account)"
```

---

## Fase 1 — Goal 7: Resposta curta em múltiplas mensagens

Entrega em bolhas separadas: se o modelo emitir parágrafos (linha em branco entre eles) ou uma resposta longa, o webhook manda 2–3 mensagens sequenciais com um pequeno intervalo (UX de “digitando de novo”). Prompt já pede curto; aqui garantimos a entrega.

### Task 1.1: `splitReply()` — função pura (TDD)

**Files:**
- Create: `C:\dev\clinica-psi-crm\src\lib\split-message.ts`
- Test: `C:\dev\clinica-psi-crm\scripts\test-split.ts`

- [ ] **Step 1: Escrever o teste que falha**

Crie `scripts/test-split.ts`:

```ts
import assert from 'node:assert';
import { splitReply } from '../src/lib/split-message';

// 1) texto curto vira 1 bolha
assert.deepStrictEqual(splitReply('Oi, tudo bem?'), ['Oi, tudo bem?']);

// 2) vazio/whitespace vira lista vazia
assert.deepStrictEqual(splitReply('   \n  '), []);

// 3) dois parágrafos (linha em branco) viram 2 bolhas
assert.deepStrictEqual(
  splitReply('Primeira parte.\n\nSegunda parte.'),
  ['Primeira parte.', 'Segunda parte.'],
);

// 4) parágrafo maior que maxLen quebra por frase, respeitando o limite
const grande = splitReply('Frase de teste. '.repeat(60), { maxLen: 120 });
assert.ok(grande.length > 1, 'devia quebrar');
assert.ok(grande.every((p) => p.length <= 120), 'toda parte <= maxLen');

// 5) respeita o teto de partes (junta o excedente na última)
const muitos = splitReply(
  Array.from({ length: 6 }, (_, i) => `Bloco ${i}.`).join('\n\n'),
  { maxParts: 3 },
);
assert.ok(muitos.length <= 3, 'no máximo maxParts');
assert.ok(muitos[2].includes('Bloco 5'), 'excedente vai pra última parte');

// 6) frase única gigante (sem pontuação) é hard-split no espaço
const semPonto = splitReply('palavra '.repeat(50), { maxLen: 100 });
assert.ok(semPonto.every((p) => p.length <= 100));

console.log(`OK test-split — ${6} asserts`);
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx tsx scripts/test-split.ts`
Expected: FAIL — `Cannot find module '../src/lib/split-message'`.

- [ ] **Step 3: Implementar o mínimo**

Crie `src/lib/split-message.ts`:

```ts
/**
 * Quebra a resposta da Camila em 1–3 mensagens de WhatsApp ("bolhas"). O modelo
 * separa mensagens intencionais com uma linha em branco; respostas longas são
 * cortadas por frase. Mantém a UX de conversa (mensagens curtas, uma coisa por
 * vez) sem depender só da disciplina do modelo. Função pura — fácil de testar.
 */
export interface SplitOpts {
  /** tamanho máximo de cada bolha (chars). WhatsApp aguenta 4096; 550 é confortável. */
  maxLen?: number;
  /** máximo de bolhas por turno. O excedente é juntado na última. */
  maxParts?: number;
}

const DEFAULT_MAX_LEN = 550;
const DEFAULT_MAX_PARTS = 3;

/** Quebra um parágrafo grande em pedaços <= maxLen, preferindo fim de frase. */
function splitBySentence(paragraph: string, maxLen: number): string[] {
  const sentences = paragraph.match(/[^.!?…]+[.!?…]+|\S[^.!?…]*$/g) ?? [paragraph];
  const out: string[] = [];
  let buf = '';
  for (const sRaw of sentences) {
    const s = sRaw.trim();
    if (!s) continue;
    if (s.length > maxLen) {
      // frase única gigante: hard-split no último espaço antes de maxLen
      if (buf) {
        out.push(buf);
        buf = '';
      }
      let rest = s;
      while (rest.length > maxLen) {
        let cut = rest.lastIndexOf(' ', maxLen);
        if (cut <= 0) cut = maxLen;
        out.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      if (rest) buf = rest;
      continue;
    }
    const candidate = buf ? `${buf} ${s}` : s;
    if (candidate.length > maxLen) {
      if (buf) out.push(buf);
      buf = s;
    } else {
      buf = candidate;
    }
  }
  if (buf) out.push(buf);
  return out;
}

export function splitReply(text: string, opts: SplitOpts = {}): string[] {
  const maxLen = opts.maxLen ?? DEFAULT_MAX_LEN;
  const maxParts = opts.maxParts ?? DEFAULT_MAX_PARTS;
  const clean = (text ?? '').trim();
  if (!clean) return [];

  const paras = clean
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const parts: string[] = [];
  for (const p of paras) {
    if (p.length <= maxLen) parts.push(p);
    else parts.push(...splitBySentence(p, maxLen));
  }
  if (parts.length === 0) return [clean];

  if (parts.length > maxParts) {
    const head = parts.slice(0, maxParts - 1);
    const tail = parts.slice(maxParts - 1).join('\n\n');
    return [...head, tail];
  }
  return parts;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx tsx scripts/test-split.ts`
Expected: `OK test-split — 6 asserts` (exit 0).

- [ ] **Step 5: Commit**

```bash
git add src/lib/split-message.ts scripts/test-split.ts
git commit -m "feat: splitReply — quebra resposta em múltiplas bolhas de WhatsApp"
```

### Task 1.2: `sendTextSequence()` + `sleep` no cliente WhatsApp

**Files:**
- Modify: `C:\dev\clinica-psi-crm\src\lib\whatsapp.ts`

- [ ] **Step 1: Adicionar helper de sleep e o envio sequencial**

Logo após a função `sendText` (linha ~71), adicione:

```ts
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Envia várias mensagens em sequência (bolhas separadas), com um respiro entre
 * elas pra parecer uma pessoa digitando. Usado com splitReply(). Se uma parte
 * falha, propaga (o webhook loga e não persiste) — parte já enviada fica no chat.
 */
export async function sendTextSequence(to: string, parts: string[], delayMs = 900): Promise<void> {
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]?.trim();
    if (!p) continue;
    await sendText(to, p);
    if (i < parts.length - 1) await sleep(delayMs);
  }
}
```

- [ ] **Step 2: Sanity de tipo**

Run: `pnpm build`
Expected: build passa.

- [ ] **Step 3: Commit**

```bash
git add src/lib/whatsapp.ts
git commit -m "feat: sendTextSequence — entrega múltiplas bolhas com respiro"
```

### Task 1.3: Wire no webhook (entrega em múltiplas mensagens)

**Files:**
- Modify: `C:\dev\clinica-psi-crm\src\app\api\whatsapp\webhook\route.ts`

- [ ] **Step 1: Importar splitReply e sendTextSequence**

No import de `@/lib/whatsapp` (linhas 2–9), adicione `sendTextSequence`:

```ts
import {
  downloadMedia,
  getVerifyToken,
  isValidSignature,
  markReadAndType,
  sendInternalAlert,
  sendText,
  sendTextSequence,
} from '@/lib/whatsapp';
```

E adicione um import novo abaixo do bloco de imports de `@/lib/conversation`:

```ts
import { splitReply } from '@/lib/split-message';
```

- [ ] **Step 2: Trocar o envio único pela sequência**

Substitua a linha 176:

```ts
      await sendText(from, turno.resposta); // se falhar, lança e não persiste a resposta
```

por:

```ts
      // Entrega em bolhas: se a resposta trouxe parágrafos ou ficou longa, manda
      // 2–3 mensagens seguidas (UX de conversa). Se falhar, lança e não persiste.
      await sendTextSequence(from, splitReply(turno.resposta));
```

(O `sendText` continua importado — ainda é usado nos fallbacks `PEDE_TEXTO`, etc.)

- [ ] **Step 3: Sanity de build**

Run: `pnpm build`
Expected: build passa.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/whatsapp/webhook/route.ts
git commit -m "feat: webhook entrega resposta em múltiplas bolhas (goal 7)"
```

### Task 1.4: Ajuste de prompt (permitir 2 mensagens) + bump de versão

**Files:**
- Modify: `C:\dev\clinica-psi-crm\src\lib\default-prompt.ts`

- [ ] **Step 1: Reforçar a regra de múltiplas mensagens no bloco TOM**

Na linha 12 (bullet “**RESPOSTAS CURTAS**”), substitua o final da frase para deixar explícito o mecanismo de bolhas. Troque:

```
Se o assunto precisa de mais informação (ex.: explicar valores, como funciona terapia de casal), quebre em partes e mande UMA por turno — nunca despeje tudo junto. Termine sempre com o próximo passo natural ou uma pergunta simples.
```

por:

```
Se o assunto precisa de mais informação (ex.: explicar valores, como funciona terapia de casal), prefira mandar em 2 mensagens curtas: escreva a primeira, depois uma LINHA EM BRANCO, depois a segunda — o sistema entrega como duas bolhas separadas. No máximo 3 bolhas. Nunca despeje tudo num bloco só. Termine sempre com o próximo passo natural ou uma pergunta simples.
```

- [ ] **Step 2: Bump da versão do prompt**

Na linha 128, troque:

```ts
export const PROMPT_VERSION = '2026-07-14-cazule-v5-antifixacao-anexo';
```

por:

```ts
export const PROMPT_VERSION = '2026-07-17-cazule-v6-bolhas-agenda';
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/default-prompt.ts
git commit -m "feat: prompt orienta resposta em 2 bolhas (goal 7) + bump versão"
```

---

## Fase 2 — Goals 2/5: Agenda via Google Sheets (Service Account)

### Task 2.1: `agenda-core.ts` — parsers + resumo (função pura, TDD)

**Files:**
- Create: `C:\dev\clinica-psi-crm\src\lib\agenda-core.ts`
- Test: `C:\dev\clinica-psi-crm\scripts\test-agenda.ts`

- [ ] **Step 1: Escrever o teste que falha**

Crie `scripts/test-agenda.ts` (fixtures espelham a planilha modelo real):

```ts
import assert from 'node:assert';
import {
  parsePsicologas,
  parseGrade,
  parseAgenda,
  resumoDisponibilidade,
  type AgendaData,
} from '../src/lib/agenda-core';

const psicRows = [
  ['Psicóloga', 'CRP', 'Abordagens', 'Atende Individual', 'Atende Casal', 'Atende Infanto-juvenil (13+)', 'Preferência do paciente (F/M)', 'Observações'],
  ['Bruna Ferreira', 'CRP 16/1', 'TCC, Humanista', 'Sim', 'Sim', 'Sim', 'F', 'Coordenação'],
  ['Amanda Souza', 'CRP 16/2', 'Psicanálise', 'Sim', 'Não', 'Não', 'F', ''],
];
const gradeRows = [
  ['Psicóloga', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'],
  ['Bruna Ferreira', '14:00-19:00', '14:00-19:00', '-', '14:00-19:00', '14:00-18:00', '-'],
  ['Amanda Souza', '-', '08:00-12:00', '08:00-12:00', '08:00-12:00', '-', '08:00-11:00'],
];
const agendaRows = [
  ['Data', 'Hora', 'Paciente', 'WhatsApp', 'Psicóloga', 'Modalidade', 'Tipo', 'Status', 'Valor (R$)', 'Pagamento', 'Nota Fiscal?', 'Observações'],
  ['15/07/2026', '18:00', 'Mariana Silva', '5527999998888', 'Bruna Ferreira', 'Individual', 'Avulsa', 'Confirmada', '75', 'Pix', 'Não', '1ª sessão'],
  ['16/07/2026', '20:00', 'Ana e Rodrigo', '5527999996666', 'Bruna Ferreira', 'Casal', 'Avulsa', 'Cancelada', '150', 'Pix', 'Não', ''],
];

const psic = parsePsicologas(psicRows);
assert.strictEqual(psic.length, 2);
assert.strictEqual(psic[0].nome, 'Bruna Ferreira');
assert.strictEqual(psic[0].casal, true);
assert.strictEqual(psic[1].casal, false);

const grade = parseGrade(gradeRows);
assert.strictEqual(grade[0].janelas['Segunda'], '14:00-19:00');
assert.strictEqual(grade[0].janelas['Quarta'], undefined); // '-' vira ausência

const agenda = parseAgenda(agendaRows);
assert.strictEqual(agenda.length, 2);
assert.strictEqual(agenda[0].paciente, 'Mariana Silva');

const data: AgendaData = { psicologas: psic, grade, agenda };

const indiv = resumoDisponibilidade(data, { modalidade: 'Individual' });
assert.ok(indiv.includes('Bruna Ferreira'), 'individual: lista Bruna');
assert.ok(indiv.includes('Amanda Souza'), 'individual: lista Amanda');
assert.ok(indiv.includes('15/07/2026 18:00'), 'mostra ocupado confirmado');
assert.ok(!indiv.includes('Ana e Rodrigo'), 'não vaza nome de paciente ocupado');
assert.ok(!indiv.includes('20:00 Bruna'), 'agendamento CANCELADO não conta como ocupado');

const casal = resumoDisponibilidade(data, { modalidade: 'Casal' });
assert.ok(casal.includes('Bruna Ferreira'), 'casal: Bruna atende');
assert.ok(!casal.includes('Amanda Souza'), 'casal: Amanda NÃO atende casal');

console.log('OK test-agenda — parsers + resumo');
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx tsx scripts/test-agenda.ts`
Expected: FAIL — módulo não encontrado.

- [ ] **Step 3: Implementar**

Crie `src/lib/agenda-core.ts`:

```ts
/**
 * Núcleo PURO da agenda: transforma as linhas cruas das abas do Google Sheets
 * (planilha "Cazule — Agenda") em estruturas e num resumo textual que a Camila
 * injeta no prompt pra propor horários reais. Sem I/O — testável com fixtures.
 * Abas esperadas: "Psicólogas", "Grade Semanal", "Agenda" (ver planilha modelo).
 */
export const DIAS = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'] as const;
export type Dia = (typeof DIAS)[number];
export type Modalidade = 'Individual' | 'Casal' | 'Infanto-juvenil';

export interface Psicologa {
  nome: string;
  crp: string;
  abordagens: string;
  individual: boolean;
  casal: boolean;
  infanto: boolean;
  prefGenero: string;
  obs: string;
}
export interface GradeRow {
  nome: string;
  janelas: Partial<Record<Dia, string>>;
}
export interface AgendaRow {
  data: string;
  hora: string;
  paciente: string;
  whatsapp: string;
  psicologa: string;
  modalidade: string;
  tipo: string;
  status: string;
  valor: string;
  pagamento: string;
  nf: string;
  obs: string;
}
export interface AgendaData {
  psicologas: Psicologa[];
  grade: GradeRow[];
  agenda: AgendaRow[];
}

const cell = (r: string[], i: number) => (r[i] ?? '').toString().trim();
const sim = (v: string) => /^s/i.test(v.trim()); // "Sim" -> true, "Não" -> false

export function parsePsicologas(rows: string[][]): Psicologa[] {
  return rows
    .slice(1)
    .filter((r) => cell(r, 0))
    .map((r) => ({
      nome: cell(r, 0),
      crp: cell(r, 1),
      abordagens: cell(r, 2),
      individual: sim(cell(r, 3)),
      casal: sim(cell(r, 4)),
      infanto: sim(cell(r, 5)),
      prefGenero: cell(r, 6),
      obs: cell(r, 7),
    }));
}

export function parseGrade(rows: string[][]): GradeRow[] {
  return rows
    .slice(1)
    .filter((r) => cell(r, 0))
    .map((r) => {
      const janelas: Partial<Record<Dia, string>> = {};
      DIAS.forEach((d, i) => {
        const v = cell(r, i + 1);
        if (v && v !== '-') janelas[d] = v;
      });
      return { nome: cell(r, 0), janelas };
    });
}

export function parseAgenda(rows: string[][]): AgendaRow[] {
  return rows
    .slice(1)
    .filter((r) => cell(r, 0))
    .map((r) => ({
      data: cell(r, 0),
      hora: cell(r, 1),
      paciente: cell(r, 2),
      whatsapp: cell(r, 3),
      psicologa: cell(r, 4),
      modalidade: cell(r, 5),
      tipo: cell(r, 6),
      status: cell(r, 7),
      valor: cell(r, 8),
      pagamento: cell(r, 9),
      nf: cell(r, 10),
      obs: cell(r, 11),
    }));
}

function capaz(p: Psicologa, mod?: Modalidade): boolean {
  if (mod === 'Casal') return p.casal;
  if (mod === 'Infanto-juvenil') return p.infanto;
  return p.individual; // default: individual
}

/**
 * Resumo compacto (bounded) da agenda pra injetar no system prompt. Lista as
 * psicólogas elegíveis à modalidade com suas janelas fixas, e os horários já
 * reservados (sem vazar nome do paciente — só data/hora/psicóloga/modalidade).
 * Cancelados são ignorados.
 */
export function resumoDisponibilidade(
  data: AgendaData,
  opts: { modalidade?: Modalidade } = {},
): string {
  const { psicologas, grade, agenda } = data;
  const mod = opts.modalidade;
  const gradeByNome = new Map(grade.map((g) => [g.nome, g.janelas]));

  const linhas = psicologas
    .filter((p) => capaz(p, mod))
    .map((p) => {
      const jan = gradeByNome.get(p.nome) ?? {};
      const dias = DIAS.filter((d) => jan[d]).map((d) => `${d.slice(0, 3).toLowerCase()} ${jan[d]}`);
      if (!dias.length) return null;
      return `- ${p.nome} (${p.abordagens}): ${dias.join(', ')}`;
    })
    .filter((x): x is string => Boolean(x));

  const ocupados = agenda
    .filter((a) => a.status.toLowerCase() !== 'cancelada' && a.data && a.hora)
    .slice(0, 12)
    .map((a) => `${a.data} ${a.hora} ${a.psicologa}${a.modalidade ? ` (${a.modalidade})` : ''}`);

  const titulo = mod ? mod.toLowerCase() : 'individual';
  return [
    '[AGENDA DA CLÍNICA — fonte: planilha. Use para SUGERIR um horário concreto e depois confirmar. NUNCA invente horário fora desta lista nem prometa sem confirmar.]',
    `Psicólogas que atendem ${titulo} e suas janelas fixas:`,
    ...(linhas.length ? linhas : ['- (nenhuma janela cadastrada — deixe a equipe confirmar)']),
    ocupados.length ? `Já reservado (não ofereça esses): ${ocupados.join('; ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx tsx scripts/test-agenda.ts`
Expected: `OK test-agenda — parsers + resumo`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agenda-core.ts scripts/test-agenda.ts
git commit -m "feat: agenda-core — parsers e resumo de disponibilidade (goal 2)"
```

### Task 2.2: `sheets.ts` — Service Account + fetch + cache

**Files:**
- Create: `C:\dev\clinica-psi-crm\src\lib\sheets.ts`

- [ ] **Step 1: Implementar (I/O isolado, nunca lança pra fora)**

Crie `src/lib/sheets.ts`:

```ts
/**
 * Leitura da planilha "Cazule — Agenda" no Google Sheets via Service Account.
 * Auth: google-auth-library (JWT), escopo readonly. Cache em memória (TTL 60s)
 * pra não bater na API a cada turno. Tudo tolerante a falha: se não houver
 * credencial/ID, ou a API falhar, agendaContexto() devolve '' e a Camila segue
 * com o comportamento antigo (propor horário deixando a equipe confirmar).
 */
import { JWT } from 'google-auth-library';
import {
  parseAgenda,
  parseGrade,
  parsePsicologas,
  resumoDisponibilidade,
  type AgendaData,
} from './agenda-core';

const CACHE_TTL_MS = 60_000;
const ABAS = ['Psicólogas', 'Grade Semanal', 'Agenda'] as const;

interface Cache {
  at: number;
  data: AgendaData;
}
const g = globalThis as unknown as { __cazuleAgendaCache?: Cache };

function serviceAccount(): { client_email: string; private_key: string } | null {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as { client_email?: string; private_key?: string };
    if (!j.client_email || !j.private_key) return null;
    // env vars costumam escapar \n do private_key — normaliza
    return { client_email: j.client_email, private_key: j.private_key.replace(/\\n/g, '\n') };
  } catch (e) {
    console.error('[sheets] GOOGLE_SERVICE_ACCOUNT_JSON inválido', e);
    return null;
  }
}

/** Busca as 3 abas (batchGet) e monta o AgendaData. Lança em erro de rede/API. */
async function fetchAgendaData(): Promise<AgendaData | null> {
  const sa = serviceAccount();
  const id = process.env.AGENDA_SHEET_ID;
  if (!sa || !id) return null;

  if (g.__cazuleAgendaCache && Date.now() - g.__cazuleAgendaCache.at < CACHE_TTL_MS) {
    return g.__cazuleAgendaCache.data;
  }

  const jwt = new JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const { token } = await jwt.getAccessToken();
  if (!token) throw new Error('sem access token da service account');

  const ranges = ABAS.map((r) => `ranges=${encodeURIComponent(r)}`).join('&');
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${id}/values:batchGet?${ranges}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Sheets API ${res.status}`);
  const json = (await res.json()) as { valueRanges?: Array<{ values?: string[][] }> };
  const vr = json.valueRanges ?? [];

  const data: AgendaData = {
    psicologas: parsePsicologas(vr[0]?.values ?? []),
    grade: parseGrade(vr[1]?.values ?? []),
    agenda: parseAgenda(vr[2]?.values ?? []),
  };
  g.__cazuleAgendaCache = { at: Date.now(), data };
  return data;
}

/**
 * Bloco de agenda pra injetar no system prompt. NUNCA lança: em qualquer falha
 * (desconfigurado, rede, API), devolve '' e a Camila segue sem a agenda.
 */
export async function agendaContexto(): Promise<string> {
  try {
    const data = await fetchAgendaData();
    if (!data || data.psicologas.length === 0) return '';
    return resumoDisponibilidade(data, {});
  } catch (e) {
    console.error('[sheets] agendaContexto falhou — seguindo sem agenda', e);
    return '';
  }
}
```

- [ ] **Step 2: Sanity de build**

Run: `pnpm build`
Expected: build passa.

- [ ] **Step 3: Commit**

```bash
git add src/lib/sheets.ts
git commit -m "feat: sheets — lê agenda por Service Account com cache e fallback (goal 2)"
```

### Task 2.3: Injetar a agenda no `computeReply`

**Files:**
- Modify: `C:\dev\clinica-psi-crm\src\lib\conversation.ts`
- Modify: `C:\dev\clinica-psi-crm\src\lib\default-prompt.ts`

- [ ] **Step 1: Importar `agendaContexto`**

No topo de `conversation.ts`, após os imports existentes (linha ~3), adicione:

```ts
import { agendaContexto } from './sheets';
```

- [ ] **Step 2: Anexar o bloco de agenda ao system prompt**

Em `computeReply` (linha ~135), troque:

```ts
  const system = (await getActivePrompt()).replaceAll(FORM_URL_PLACEHOLDER, formUrl());
  const result = await runTriagem({ system, messages: history });
```

por:

```ts
  let system = (await getActivePrompt()).replaceAll(FORM_URL_PLACEHOLDER, formUrl());
  // Anexa a agenda real (Google Sheets) quando configurada. Append em vez de
  // placeholder: assim vale mesmo se o prompt ativo vier do app_config (DB).
  const agenda = await agendaContexto();
  if (agenda) system = `${system}\n\n${agenda}`;
  const result = await runTriagem({ system, messages: history });
```

- [ ] **Step 3: Orientar o modelo a usar a agenda (default-prompt)**

Em `default-prompt.ts`, no `Passo 2 — Horário` (linha ~97), acrescente ao final da frase:

```
 Se houver uma lista de horários da clínica no contexto (bloco [AGENDA DA CLÍNICA]), proponha um horário REAL dessa lista e confirme; se não houver, diga que vai verificar a agenda com a equipe.
```

- [ ] **Step 4: Sanity de build**

Run: `pnpm build`
Expected: build passa.

- [ ] **Step 5: Commit**

```bash
git add src/lib/conversation.ts src/lib/default-prompt.ts
git commit -m "feat: Camila propõe horários reais da planilha (goals 2/5)"
```

---

## Fase 3 — Goal 3: Proatividade / follow-up de leads frios

### Task 3.1: Colunas de follow-up no schema

**Files:**
- Modify: `C:\dev\clinica-psi-crm\src\lib\schema.ts`

- [ ] **Step 1: Adicionar o ALTER idempotente**

Após o bloco `ALTER TABLE wa_conversations ADD COLUMN ... pausada ...` (linha ~40), adicione:

```ts
    // Colunas de follow-up proativo: quantas vezes já reengajamos esse lead e
    // quando foi a última — pra não spammar. Idempotente.
    await client.query(`
      ALTER TABLE wa_conversations
        ADD COLUMN IF NOT EXISTS followup_count    INT NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS followup_last_at  TIMESTAMPTZ;
    `);
```

- [ ] **Step 2: Sanity de build**

Run: `pnpm build`
Expected: build passa.

- [ ] **Step 3: Commit**

```bash
git add src/lib/schema.ts
git commit -m "feat: schema — colunas followup_count/followup_last_at (goal 3)"
```

### Task 3.2: `sendTemplate()` no cliente WhatsApp

**Files:**
- Modify: `C:\dev\clinica-psi-crm\src\lib\whatsapp.ts`

- [ ] **Step 1: Adicionar o envio de template**

Após `sendTextSequence` (da Task 1.2), adicione:

```ts
/**
 * Envia um template aprovado (Message Template da Meta). Necessário pra falar com
 * um contato FORA da janela de 24h (reengajamento). `name` = nome do template
 * aprovado; sem variáveis no corpo (o texto vive na Meta). lang default pt_BR.
 */
export function sendTemplate(to: string, name: string, lang = 'pt_BR'): Promise<void> {
  return graphPost({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: { name, language: { code: lang } },
  });
}
```

- [ ] **Step 2: Sanity de build**

Run: `pnpm build`
Expected: build passa.

- [ ] **Step 3: Commit**

```bash
git add src/lib/whatsapp.ts
git commit -m "feat: sendTemplate — mensagem de template p/ fora da janela 24h (goal 3)"
```

### Task 3.3: `followup.ts` — predicados puros (TDD) + runner

**Files:**
- Create: `C:\dev\clinica-psi-crm\src\lib\followup.ts`
- Test: `C:\dev\clinica-psi-crm\scripts\test-followup.ts`

- [ ] **Step 1: Escrever o teste que falha (só a lógica pura)**

Crie `scripts/test-followup.ts`:

```ts
import assert from 'node:assert';
import { decideChannel, MENSAGEM_RETENCAO } from '../src/lib/followup';

const now = new Date('2026-07-17T12:00:00Z');

// dentro de 24h do último inbound -> mensagem livre
assert.strictEqual(
  decideChannel(new Date('2026-07-17T06:00:00Z'), now),
  'freeform',
);
// mais de 24h -> template
assert.strictEqual(
  decideChannel(new Date('2026-07-15T06:00:00Z'), now),
  'template',
);
// sem inbound conhecido -> template (conservador)
assert.strictEqual(decideChannel(null, now), 'template');

// a mensagem de retenção é a #7 do FAQ da Bruna
assert.ok(/ainda deseja agendar/i.test(MENSAGEM_RETENCAO));

console.log('OK test-followup — decideChannel');
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx tsx scripts/test-followup.ts`
Expected: FAIL — módulo não encontrado.

- [ ] **Step 3: Implementar**

Crie `src/lib/followup.ts`:

```ts
/**
 * Proatividade (goal 3): reengaja leads que demonstraram interesse mas sumiram.
 * Cron in-process (como o cleanup LGPD). Dentro da janela de 24h do WhatsApp
 * manda a mensagem 7 do FAQ (texto livre); fora da janela usa um template
 * aprovado. Gate por env: FOLLOWUP_ENABLED e FOLLOWUP_TEMPLATE_NAME.
 */
import { query } from './db';
import { sendText, sendTemplate } from './whatsapp';

/** Mensagem 7 do FAQ da Bruna — reengajamento dentro da janela de 24h. */
export const MENSAGEM_RETENCAO =
  'Olá! Não tive seu retorno, e estou passando para saber se você ainda deseja agendar sua primeira sessão. Podemos continuar o atendimento?';

const JANELA_MS = 24 * 60 * 60 * 1000;
const MAX_FOLLOWUPS = 2; // no máximo 2 reengajamentos por lead

export type Canal = 'freeform' | 'template';

/** Decide o canal pelo tempo desde a última mensagem RECEBIDA do paciente. */
export function decideChannel(lastInboundAt: Date | null, now: Date): Canal {
  if (!lastInboundAt) return 'template';
  return now.getTime() - lastInboundAt.getTime() < JANELA_MS ? 'freeform' : 'template';
}

interface ColdLead {
  wa_id: string;
  followup_count: number;
  last_inbound: Date | null;
}

/**
 * Leads frios: interessados (têm motivação captada), não prontos, não pausados,
 * parados há +24h, abaixo do teto de follow-ups e com respiro de 24h desde o
 * último. LIMIT baixo pra não estourar rate limit da Meta num tick só.
 */
async function findColdLeads(): Promise<ColdLead[]> {
  const { rows } = await query<ColdLead>(
    `SELECT c.wa_id, c.followup_count,
            (SELECT max(m.created_at) FROM wa_messages m
              WHERE m.wa_id = c.wa_id AND m.role = 'user') AS last_inbound
       FROM wa_conversations c
      WHERE c.pausada = FALSE
        AND c.pronto = FALSE
        AND c.updated_at < now() - interval '24 hours'
        AND c.followup_count < $1
        AND (c.followup_last_at IS NULL OR c.followup_last_at < now() - interval '24 hours')
        AND c.lead ->> 'motivacao' IS NOT NULL
      ORDER BY c.updated_at ASC
      LIMIT 25`,
    [MAX_FOLLOWUPS],
  );
  return rows;
}

async function marcarEnviado(waId: string): Promise<void> {
  await query(
    `UPDATE wa_conversations
        SET followup_count = followup_count + 1, followup_last_at = now(), updated_at = updated_at
      WHERE wa_id = $1`,
    [waId],
  );
}

/** Roda um ciclo de follow-up. Retorna quantos foram reengajados. */
export async function runFollowup(now = new Date()): Promise<number> {
  const templateName = process.env.FOLLOWUP_TEMPLATE_NAME;
  const leads = await findColdLeads();
  let enviados = 0;
  for (const lead of leads) {
    const canal = decideChannel(lead.last_inbound ? new Date(lead.last_inbound) : null, now);
    try {
      if (canal === 'freeform') {
        await sendText(lead.wa_id, MENSAGEM_RETENCAO);
      } else if (templateName) {
        await sendTemplate(lead.wa_id, templateName);
      } else {
        console.warn(`[followup] ${lead.wa_id} fora da janela e sem FOLLOWUP_TEMPLATE_NAME — pulando.`);
        continue;
      }
      await marcarEnviado(lead.wa_id);
      enviados++;
    } catch (e) {
      console.error(`[followup] falha ao reengajar ${lead.wa_id}`, e);
    }
  }
  if (enviados) console.log(`[followup] ${enviados} lead(s) reengajado(s).`);
  return enviados;
}

/**
 * Agenda o follow-up a cada 1h (como o cleanup). Gate: FOLLOWUP_ENABLED !== 'false'.
 * .unref() pra não segurar o processo. Roda no container persistente do Railway.
 */
export function scheduleFollowup(): void {
  if (process.env.FOLLOWUP_ENABLED === 'false') {
    console.log('[followup] desativado (FOLLOWUP_ENABLED=false).');
    return;
  }
  const run = () => runFollowup().catch((e) => console.error('[followup] ciclo falhou', e));
  const timer = setInterval(run, 60 * 60 * 1000);
  timer.unref?.();
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx tsx scripts/test-followup.ts`
Expected: `OK test-followup — decideChannel`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/followup.ts scripts/test-followup.ts
git commit -m "feat: followup — reengaja leads frios (janela 24h + template) (goal 3)"
```

### Task 3.4: Agendar o follow-up no boot

**Files:**
- Modify: `C:\dev\clinica-psi-crm\src\instrumentation.ts`

- [ ] **Step 1: Chamar `scheduleFollowup` junto do cleanup**

Em `register()`, dentro do `try` onde já chama `scheduleCleanup()` (linha ~27–28), adicione:

```ts
    const { scheduleCleanup } = await import('@/lib/maintenance');
    scheduleCleanup();
    const { scheduleFollowup } = await import('@/lib/followup');
    scheduleFollowup();
```

- [ ] **Step 2: Sanity de build**

Run: `pnpm build`
Expected: build passa.

- [ ] **Step 3: Commit**

```bash
git add src/instrumentation.ts
git commit -m "feat: agenda o cron de follow-up no boot (goal 3)"
```

---

## Fase 4 — Refinos (goals 1, 4, 8)

### Task 4.1: Robustez de áudio (`audio.voice`)

**Files:**
- Modify: `C:\dev\clinica-psi-crm\src\app\api\whatsapp\webhook\route.ts`

- [ ] **Step 1: Cobrir o caso `type:"audio"` com flag `voice`**

O `extractText` já trata `msg.type === 'audio' || 'voice'`. Reforce o tipo `WebhookMessage` pra aceitar o campo `voice` boolean dentro de `audio` (algumas mensagens de microfone vêm como `audio` com `voice:true`). Na interface `WebhookMessage` (linha ~231), troque:

```ts
  audio?: { id?: string; mime_type?: string };
```

por:

```ts
  audio?: { id?: string; mime_type?: string; voice?: boolean };
```

(Nenhuma mudança de lógica: o download já usa `msg.audio?.id || msg.voice?.id`. Este passo só evita erro de tipo se algum código futuro ler `voice`. Verificação, não refatoração.)

- [ ] **Step 2: Sanity de build**

Run: `pnpm build`
Expected: build passa.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/whatsapp/webhook/route.ts
git commit -m "chore: tipa audio.voice no payload do webhook (robustez goal 1)"
```

> Goals 4 e 8 não precisam de código novo — só das env vars `FORM_URL` e `NOTIFY_ALERT_NUMBERS` no Railway (Task 6.2). O fluxo `enviarForm` → `pauseConversation` → `notifyTeam` já está implementado e coberto pelo cenário “comprovante em imagem” do `test-triagem.ts`.

---

## Fase 5 — Rodada de testes (Gemini paciente/lead → Fable revisa → Opus corrige)

### Task 5.1: `sim-conversa.ts` — simulador multi-turno dirigido por Gemini

**Files:**
- Create: `C:\dev\clinica-psi-crm\scripts\sim-conversa.ts`

- [ ] **Step 1: Implementar o harness**

Crie `scripts/sim-conversa.ts`:

```ts
/**
 * Simulador de conversa: o Gemini encena um PACIENTE (ou LEAD frio) e conversa,
 * turno a turno, com a Camila (runTriagem, mesma lógica do webhook). Serve pra
 * caçar regressões de UX/fluxo antes do deploy. Imprime a transcrição completa +
 * a ficha final + flags (pronto/enviarForm).
 *
 * Rodar:  npx tsx --env-file=.env.local scripts/sim-conversa.ts
 */
import { readFileSync } from 'node:fs';
try {
  for (const linha of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = linha.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) {
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  }
} catch {}

import { GoogleGenAI } from '@google/genai';
import { runTriagem } from '../src/lib/triagem';
import { DEFAULT_PROMPT } from '../src/lib/default-prompt';
import { splitReply } from '../src/lib/split-message';

interface Persona {
  nome: string;
  system: string;
  maxTurnos: number;
  encerra: (t: { paciente: string; camila: string; enviarForm: boolean }[]) => boolean;
}

const PACIENTE_INDIVIDUAL: Persona = {
  nome: 'paciente-individual-ansiedade',
  system: `Você está simulando uma PACIENTE real no WhatsApp de uma clínica de psicologia.
Persona: Mariana, 29 anos, ansiosa por causa do trabalho, quer começar terapia INDIVIDUAL.
Regras: escreva como no WhatsApp, curto, uma mensagem por vez, em PT-BR. NÃO seja robótica.
Fluxo natural: cumprimente, pergunte o preço, demonstre interesse, aceite agendar, escolha um
horário que a atendente propuser, diga que vai pagar por Pix e, quando ela pedir o comprovante,
responda "[o paciente enviou uma imagem/anexo pelo WhatsApp — se o pagamento acabou de ser combinado, é provavelmente o comprovante]".
Responda SOMENTE com a próxima fala da paciente, sem aspas, sem narração.`,
  maxTurnos: 12,
  encerra: (t) => t.some((x) => x.enviarForm),
};

const LEAD_FRIO: Persona = {
  nome: 'lead-frio-curioso',
  system: `Você simula um LEAD curioso no WhatsApp de uma clínica de psicologia.
Persona: pergunta o preço, fica em dúvida, dá respostas evasivas e vai perdendo o interesse.
Nas últimas falas seja lacônico ("vou pensar", "depois te falo"). Escreva curto, PT-BR, uma
mensagem por vez. Responda SOMENTE com a próxima fala, sem aspas.`,
  maxTurnos: 5,
  encerra: () => false,
};

async function proximaFalaPaciente(
  ai: GoogleGenAI,
  persona: Persona,
  transcript: { paciente: string; camila: string }[],
): Promise<string> {
  const historico = transcript
    .map((t) => `PACIENTE: ${t.paciente}\nATENDENTE: ${t.camila}`)
    .join('\n');
  const prompt = `${persona.system}\n\nConversa até agora:\n${historico || '(ainda não começou)'}\n\nPróxima fala da paciente:`;
  const resp = await ai.models.generateContent({
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: { thinkingConfig: { thinkingBudget: 0 } },
  });
  return (resp.text ?? '').trim().replace(/^["']|["']$/g, '');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function rodarPersona(ai: GoogleGenAI, persona: Persona) {
  console.log(`\n\x1b[1m=== SIM: ${persona.nome} ===\x1b[0m`);
  const history: { role: 'user' | 'assistant'; content: string }[] = [];
  const transcript: { paciente: string; camila: string; enviarForm: boolean }[] = [];

  for (let i = 0; i < persona.maxTurnos; i++) {
    const fala = await proximaFalaPaciente(ai, persona, transcript);
    if (!fala) break;
    history.push({ role: 'user', content: fala });
    const res = await runTriagem({ system: DEFAULT_PROMPT, messages: history });
    history.push({ role: 'assistant', content: res.resposta });
    const bolhas = splitReply(res.resposta);
    transcript.push({ paciente: fala, camila: res.resposta, enviarForm: res.enviarForm });

    console.log(`\x1b[36mpaciente:\x1b[0m ${fala}`);
    bolhas.forEach((b, k) => console.log(`\x1b[35mcamila#${k + 1}:\x1b[0m ${b}`));
    if (res.enviarForm) console.log('  \x1b[33m>> enviarForm=true (handoff)\x1b[0m');
    if (persona.encerra(transcript)) break;
    await sleep(1200);
  }

  const ultimo = history.filter((h) => h.role === 'assistant').length;
  console.log(`\x1b[1mResumo ${persona.nome}: ${transcript.length} turnos, respostas do assistente=${ultimo}\x1b[0m`);
  return transcript;
}

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY ausente. Rode: npx tsx --env-file=.env.local scripts/sim-conversa.ts');
    process.exit(1);
  }
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  await rodarPersona(ai, PACIENTE_INDIVIDUAL);
  await rodarPersona(ai, LEAD_FRIO);
  console.log('\n\x1b[1mSimulação concluída. Revise as transcrições acima.\x1b[0m');
}

main();
```

- [ ] **Step 2: Rodar a simulação**

Run: `npx tsx --env-file=.env.local scripts/sim-conversa.ts`
Expected: duas transcrições completas; a do paciente deve chegar em `enviarForm=true`; a do lead frio deve terminar sem `pronto`. Salve a saída num arquivo (`... > sim-out.txt`) pra a revisão.

- [ ] **Step 3: Commit**

```bash
git add scripts/sim-conversa.ts
git commit -m "test: simulador de conversa Gemini paciente/lead vs Camila"
```

### Task 5.2: Revisão por Fable + correções por Opus (loop)

Este passo é executado pelo orquestrador (sessão Opus/ultracode), não é código versionado.

- [ ] **Step 1: Rodar `test-triagem`, `sim-conversa` e os testes unitários; coletar transcrições**

```bash
npx tsx scripts/test-split.ts
npx tsx scripts/test-agenda.ts
npx tsx scripts/test-followup.ts
npx tsx --env-file=.env.local scripts/test-triagem.ts
npx tsx --env-file=.env.local scripts/sim-conversa.ts
```

- [ ] **Step 2: Revisão adversarial com modelo Fable**

Despachar um subagente **com `model: 'fable'`** passando: (a) as transcrições da simulação; (b) os critérios (respostas curtas/2 bolhas, informa valores, propõe horário real da agenda, só envia form após comprovante, desliga após handoff, não pede texto quando veio áudio); (c) o `default-prompt.ts`. Pedir uma lista priorizada de correções concretas (bug de código, ajuste de prompt, UX), cada uma com arquivo:linha e a mudança sugerida.

- [ ] **Step 3: Executar as correções (Opus/ultracode)**

Para cada correção aprovada: aplicar a mudança (prompt e/ou código), rodar novamente os testes/sim, e repetir a revisão Fable até não sobrar correção relevante (ou 2 rodadas sem novos achados). Fazer commits pequenos por correção.

---

## Fase 6 — Verificação final e deploy

### Task 6.1: Suíte completa + build

- [ ] **Step 1: Rodar tudo**

```bash
npx tsx scripts/test-split.ts
npx tsx scripts/test-agenda.ts
npx tsx scripts/test-followup.ts
npx tsx --env-file=.env.local scripts/test-triagem.ts
pnpm build
```
Expected: todos os testes PASS e `pnpm build` sem erros.

### Task 6.2: Configurar Railway e fazer deploy

**Files:** nenhum (operacional). Serviço Railway `clinica-psi-crm` (projeto `59c5392a-564d-4716-8c6a-7f7579b27a42`, env `production`).

- [ ] **Step 1: Linkar o projeto**

```bash
railway link -p 59c5392a-564d-4716-8c6a-7f7579b27a42 -e production -s clinica-psi-crm
```

- [ ] **Step 2: Setar as env vars (valores reais dos runbooks R1/R2)**

```bash
railway variable set FORM_URL="<url-do-google-forms>"
railway variable set NOTIFY_ALERT_NUMBERS="5527981178233,5549999551051"
railway variable set GEMINI_TRANSCRIBE_MODEL="gemini-2.5-flash-lite"
railway variable set AGENDA_SHEET_ID="<id-da-planilha>"
railway variable set GOOGLE_SERVICE_ACCOUNT_JSON='<conteudo-do-key.json-em-uma-linha>'
railway variable set FOLLOWUP_ENABLED="true"
railway variable set FOLLOWUP_TEMPLATE_NAME="retomada_atendimento"
```
(Confirmar também que `GEMINI_API_KEY`, `DATABASE_URL`, `WHATSAPP_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `ADMIN_API_KEY` já estão setados.)

- [ ] **Step 3: Push com a conta certa → auto-deploy**

```bash
gh auth switch --user vertechsolutions
gh auth setup-git
git push origin master
```
Expected: Railway detecta o push em `master` e faz o deploy.

- [ ] **Step 4: Verificar o deploy**

```bash
railway deployment list --json
```
E `GET https://<dominio-railway>/api/health` → 200. Se o prompt não mudou no WhatsApp, lembrar da armadilha do `app_config.system_prompt` (DB sobrescreve o código — ver `CONTEXTO-CAZULE.md` §1): calibrar pela tela `/` ou `DELETE FROM app_config WHERE key='system_prompt'`.

- [ ] **Step 5: Smoke test em produção**

Do WhatsApp de teste: (1) mandar áudio → responde em texto natural; (2) perguntar preço casal → R$150/550; (3) pedir horário → propõe horário real da planilha; (4) fluxo até comprovante → confirma + form + alerta pra Bruna/Murilo + IA fica muda depois.

---

## Self-Review (feito pelo autor do plano)

**1. Cobertura das 8 goals:**
- Goal 1 (áudio): baseline ✅ + Task 4.1 (robustez). ✔
- Goal 2 (agenda Drive): Fase 2 (agenda-core + sheets + injeção) + R1. ✔
- Goal 3 (proatividade): Fase 3 (schema + template + followup + cron) + R2. ✔
- Goal 4 (form pós-pagamento): baseline ✅ + `FORM_URL` (Task 0.1/6.2). ✔
- Goal 5 (planilha modelo + email + Drive-banco): modelo já existe; R1 sobe como Google Sheet + Drive-banco; integração na Fase 2. ✔ (criar o mailbox `camilaia@` é ato de Workspace admin — item de runbook, não bloqueia o código via Service Account.)
- Goal 6 (FAQ): baseline ✅ (19 P&R já no prompt). ✔
- Goal 7 (curto/múltiplas msgs): Fase 1 (splitReply + sequência + prompt). ✔
- Goal 8 (desligar após form): baseline ✅ + `NOTIFY_ALERT_NUMBERS`. ✔
- Rodada de testes (Gemini/Fable/Opus): Fase 5. ✔

**2. Placeholder scan:** sem TODOs/“handle edge cases”. Código completo em cada task de código. Runbooks têm passos concretos. ✔

**3. Consistência de tipos/nomes:** `AgendaData`/`Psicologa`/`GradeRow`/`AgendaRow` definidos em `agenda-core.ts` e usados igual em `sheets.ts` e no teste. `resumoDisponibilidade(data, {modalidade})`, `agendaContexto()`, `splitReply(text, opts)`, `sendTextSequence(to, parts, delay)`, `sendTemplate(to, name, lang)`, `decideChannel(lastInboundAt, now)`, `runFollowup`, `scheduleFollowup` — assinaturas batem entre definição, uso e testes. ✔

**Riscos conhecidos / notas de execução:**
- `app_config.system_prompt` no DB sobrescreve o `DEFAULT_PROMPT`: as mudanças de prompt (Tasks 1.4/2.3) só valem no WhatsApp se o DB estiver vazio ou for recalibrado. A injeção da agenda usa *append* justamente pra sobreviver a isso.
- `google-auth-library` aumenta o bundle; se o build do Railway reclamar, é a única dep nova.
- Follow-up depende de aprovação do template na Meta (R2) pra pegar leads fora de 24h; até lá, só reengaja dentro da janela e loga aviso.
- Sem framework de teste: os testes são scripts `tsx`. Se o Murilo quiser CI, vira leva separada.
