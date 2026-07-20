# Nome completo + validação real do comprovante Pix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> Ao iniciar a execução, copie este plano para `docs/superpowers/plans/2026-07-20-camila-nome-e-comprovante.md`.

**Goal:** (1) A Camila percebe nome incompleto ("Murilo M") e pede o nome completo uma vez, sem travar o fluxo. (2) O comprovante Pix enviado em imagem/PDF é LIDO (Gemini vision): valor e destinatário são extraídos; chave errada ou imagem que não é comprovante **bloqueiam o handoff por código**; valor divergente do combinado faz a Camila apontar e não confirmar. (3) O alerta de handoff vira uma notificação de trabalho pra equipe (Camila humana): ficha do paciente + status do comprovante + checklist (conferir pagamento → conferir formulário → ajustar horário no PsicoManager).

**Architecture:** Reusa os padrões existentes: `transcribeAudio` (`src/lib/transcribe.ts` — Gemini multimodal + retry + best-effort null) e a separação `agenda-core` (núcleo puro testável) / `sheets` (I/O). Novo `comprovante-core.ts` (puro: verificação de chave tolerante a formatos + montagem do marcador de histórico) + `comprovante.ts` (Gemini vision com responseSchema). O webhook baixa a mídia, analisa, injeta um marcador RICO no histórico (fatos + veredito da chave); o prompt v14 valida o VALOR (só o modelo sabe o que foi combinado — avulsa/pacote/quinzenal, individual/casal); backstop determinístico: análise diz "chave não confere" ou "não é comprovante" e o modelo marcou `enviarForm` → suprimido por código. **Fail-open**: análise indisponível (foto ruim, erro Gemini) → fluxo atual (marcador simples) + linha de "⚠️ conferir manualmente" no alerta da equipe — paciente real nunca fica bloqueado por OCR.

**Tech Stack:** TypeScript, `@google/genai` (vision aceita image/* e application/pdf inline), scripts `tsx` + `node:assert`.

**Contexto:** teste real do Murilo (49999551051): "Murilo M" passou como nome completo, e um comprovante qualquer disparou confirmação + form. Chave esperada hoje (teste): celular da Bruna `+55 27 98117-8233` (já é a env `PIX_INFO`; a chave esperada é derivada dela — trocar a chave continua sendo 1 env, sem deploy).

---

### Task 1: `comprovante-core.ts` (puro) — verificação de chave + marcador — TDD

**Files:**
- Create: `src/lib/comprovante-core.ts`
- Test: `scripts/test-comprovante-core.ts`

- [ ] **Step 1: Teste que falha** — `scripts/test-comprovante-core.ts`:

```ts
/**
 * Testes do núcleo puro da validação de comprovante (sem Gemini).
 * Rodar:  npx tsx scripts/test-comprovante-core.ts
 */
import assert from 'node:assert';
import {
  verificarDestinatario,
  montarMarcadorComprovante,
  type AnaliseComprovante,
} from '../src/lib/comprovante-core';

const ESPERADO = 'Chave Pix (celular): +55 27 98117-8233 — em nome de Bruna (Clínica Cazule)';

const base: AnaliseComprovante = {
  ehComprovante: true,
  valor: 280,
  nomeDestinatario: 'Bruna Amorim',
  chaveDestino: '+55 27 98117-8233',
  instituicao: 'Nubank',
  dataHora: '20/07/2026 14:03',
};

// chave em formatos diferentes → CONFERE (comparação por sufixo de dígitos)
assert.strictEqual(verificarDestinatario(base, ESPERADO), 'confere');
assert.strictEqual(verificarDestinatario({ ...base, chaveDestino: '(27) 98117-8233' }, ESPERADO), 'confere');
assert.strictEqual(verificarDestinatario({ ...base, chaveDestino: '5527981178233' }, ESPERADO), 'confere');

// chave claramente OUTRA → NÃO CONFERE
assert.strictEqual(verificarDestinatario({ ...base, chaveDestino: '+55 11 91234-5678' }, ESPERADO), 'nao_confere');

// chave mascarada/ausente mas nome bate → confere (sinal fraco aceito)
assert.strictEqual(verificarDestinatario({ ...base, chaveDestino: null }, ESPERADO), 'confere');
// chave ausente e nome diferente → inconclusivo (OCR de nome é frágil; não acusa)
assert.strictEqual(
  verificarDestinatario({ ...base, chaveDestino: null, nomeDestinatario: 'José Carlos' }, ESPERADO),
  'inconclusivo',
);
// chave e-mail: containment normalizado
assert.strictEqual(
  verificarDestinatario(
    { ...base, chaveDestino: 'financeiro@cazule.com.br' },
    'Chave Pix (e-mail): financeiro@cazule.com.br — em nome de Clínica Cazule',
  ),
  'confere',
);

// marcadores
const mOk = montarMarcadorComprovante(base, 'confere');
assert.ok(/COMPROVANTE/i.test(mOk) && /280/.test(mOk) && /CONFERE/.test(mOk), 'marcador válido');
assert.ok(/valor.*bate|confira.*valor/i.test(mOk), 'instrui a conferir o valor combinado');

const mRuim = montarMarcadorComprovante({ ...base, chaveDestino: '+55 11 91234-5678' }, 'nao_confere');
assert.ok(/N[ÃA]O CONFERE/i.test(mRuim) && /n[ãa]o confirme/i.test(mRuim), 'marcador de chave errada bloqueia');

const mNao = montarMarcadorComprovante({ ...base, ehComprovante: false }, 'inconclusivo');
assert.ok(/N[ÃA]O parece ser um comprovante/i.test(mNao), 'marcador de não-comprovante');

const mFalha = montarMarcadorComprovante(null, 'inconclusivo');
assert.ok(/an[áa]lise autom[áa]tica indispon[íi]vel/i.test(mFalha), 'fallback fail-open');

console.log('test-comprovante-core: todos os asserts passaram ✔');
```

- [ ] **Step 2: Rodar e ver falhar** — `npx tsx scripts/test-comprovante-core.ts` → MODULE_NOT_FOUND.

- [ ] **Step 3: Implementar `src/lib/comprovante-core.ts`**:

```ts
// Núcleo PURO da validação de comprovante Pix (sem I/O — testável).
// A análise da imagem (Gemini vision) fica em comprovante.ts; aqui entram a
// comparação do destinatário com a chave da clínica e a montagem do marcador
// que vai pro histórico da conversa (o prompt decide o VALOR — só ele sabe o
// que foi combinado com o paciente).

export interface AnaliseComprovante {
  ehComprovante: boolean;
  valor: number | null;            // em reais (ex.: 280)
  nomeDestinatario: string | null; // quem RECEBEU
  chaveDestino: string | null;     // chave Pix do destinatário como aparece
  instituicao: string | null;
  dataHora: string | null;
}

export type VerificacaoDestinatario = 'confere' | 'nao_confere' | 'inconclusivo';

const digitos = (s: string) => s.replace(/\D/g, '');
const normaliza = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * Compara o destinatário extraído do comprovante com a chave esperada da
 * clínica (texto livre da env PIX_INFO ou PIX_CHAVE). Tolerante a formatos:
 * chaves numéricas comparam pelo SUFIXO de 8+ dígitos; e-mail por containment;
 * sem chave legível, o nome do destinatário vale como sinal fraco (bate →
 * confere; não bate → inconclusivo, nunca acusa por OCR de nome).
 */
export function verificarDestinatario(
  analise: AnaliseComprovante,
  esperadoRaw: string,
): VerificacaoDestinatario {
  const expDig = digitos(esperadoRaw);
  const chave = analise.chaveDestino?.trim() || '';
  const chaveDig = digitos(chave);

  if (chaveDig.length >= 8 && expDig.length >= 8) {
    const a = chaveDig.slice(-8);
    const b = expDig.slice(-8);
    return a === b ? 'confere' : 'nao_confere';
  }
  if (chave.includes('@')) {
    return normaliza(esperadoRaw).includes(normaliza(chave)) ? 'confere' : 'nao_confere';
  }
  // sem chave comparável: tenta o nome (sinal fraco)
  const nome = analise.nomeDestinatario?.trim();
  if (nome) {
    const esperadoNorm = normaliza(esperadoRaw);
    const bateNome = normaliza(nome)
      .split(/\s+/)
      .some((p) => p.length >= 4 && esperadoNorm.includes(p));
    if (bateNome) return 'confere';
  }
  return 'inconclusivo';
}

/**
 * Marcador injetado no histórico no lugar da imagem. Único ponto que gera esse
 * texto (os testes usam a MESMA função — fixture nunca desvia da produção).
 */
export function montarMarcadorComprovante(
  analise: AnaliseComprovante | null,
  verificacao: VerificacaoDestinatario,
): string {
  if (analise === null) {
    return (
      '[o paciente enviou uma imagem/anexo pelo WhatsApp — análise automática indisponível. ' +
      'Se o pagamento acabou de ser combinado, trate como possível comprovante e siga o fluxo normal; a equipe confere manualmente.]'
    );
  }
  if (!analise.ehComprovante) {
    return (
      '[o paciente enviou uma imagem pelo WhatsApp. Análise automática: a imagem NÃO parece ser um comprovante de pagamento. ' +
      'NÃO confirme pagamento por causa dela. Se o pagamento tinha acabado de ser combinado, peça com gentileza o comprovante; senão, pergunte do que se trata.]'
    );
  }
  const valor = analise.valor != null ? `R$ ${analise.valor.toFixed(2).replace('.', ',')}` : 'não legível';
  const dest = [analise.nomeDestinatario, analise.chaveDestino ? `chave ${analise.chaveDestino}` : null]
    .filter(Boolean)
    .join(' — ') || 'não legível';
  const cabeca = `[o paciente enviou uma imagem pelo WhatsApp. Análise automática: COMPROVANTE de pagamento detectado — valor: ${valor}; destinatário: ${dest}${analise.instituicao ? `; instituição: ${analise.instituicao}` : ''}${analise.dataHora ? `; data: ${analise.dataHora}` : ''}.`;
  if (verificacao === 'nao_confere') {
    return (
      `${cabeca} ⚠️ A chave do destinatário NÃO CONFERE com a chave Pix da clínica. NÃO confirme o pagamento e NÃO envie o formulário: ` +
      'diga com gentileza que o comprovante parece ter sido feito para outro destinatário, reenvie a chave correta da clínica e peça pra pessoa verificar.]'
    );
  }
  const chaveNota =
    verificacao === 'confere'
      ? 'A chave do destinatário CONFERE com a da clínica.'
      : 'Não foi possível confirmar a chave do destinatário (a equipe confere manualmente).';
  return (
    `${cabeca} ${chaveNota} Antes de confirmar, confira você se o VALOR acima bate com a opção que o paciente escolheu ` +
    '(individual: avulsa R$ 75,00 / pacote R$ 280,00 / quinzenal R$ 150,00; casal: avulsa R$ 150,00 / pacote R$ 550,00). ' +
    'Se o valor NÃO bater, NÃO confirme e NÃO envie o formulário: aponte a diferença com gentileza e peça pra pessoa verificar o pagamento.]'
  );
}

/** Chave esperada da clínica: PIX_CHAVE (se setada) senão o texto da PIX_INFO. */
export function chaveEsperada(): string {
  return process.env.PIX_CHAVE?.trim() || process.env.PIX_INFO?.trim() || '';
}
```

- [ ] **Step 4: Rodar e ver passar** — `npx tsx scripts/test-comprovante-core.ts` → ✔
- [ ] **Step 5: Commit** — `git add src/lib/comprovante-core.ts scripts/test-comprovante-core.ts && git commit -m "feat: núcleo puro da validação de comprovante Pix (chave + marcador)"`

---

### Task 2: `comprovante.ts` (Gemini vision) + script live

**Files:**
- Create: `src/lib/comprovante.ts`
- Create: `scripts/test-comprovante-live.ts`

- [ ] **Step 1: Implementar `src/lib/comprovante.ts`** (mesmo padrão do `transcribe.ts`: retry transitório, best-effort `null`, limite 15MB):

```ts
import { GoogleGenAI, Type } from '@google/genai';
import type { AnaliseComprovante } from './comprovante-core';

/**
 * Leitura de comprovante Pix via Gemini vision (aceita image/* e
 * application/pdf inline). Best-effort: null em falha — o chamador cai no
 * fluxo fail-open (marcador simples + equipe confere manualmente).
 */
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const MAX_BYTES = 15 * 1024 * 1024;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isTransient = (m: string) => /503|UNAVAILABLE|overloaded|429|RESOURCE_EXHAUSTED/i.test(m);

const PROMPT =
  'Você analisa uma imagem (ou PDF) enviada por um paciente no WhatsApp de uma clínica. ' +
  'Diga se é um COMPROVANTE de pagamento/transferência (Pix, TED, etc.) e extraia os dados do DESTINATÁRIO (quem recebeu), não do pagador. ' +
  'Campos: ehComprovante (bool); valor (número em reais, ex. 280.00, ou null); nomeDestinatario (nome de quem recebeu, ou null); ' +
  'chaveDestino (a chave Pix/conta do destinatário EXATAMENTE como aparece, ou null); instituicao (banco/app, ou null); dataHora (como aparece, ou null). ' +
  'NÃO invente: campo ilegível ou ausente = null. Se não for comprovante, ehComprovante=false e demais campos null.';

const schema = {
  type: Type.OBJECT,
  properties: {
    ehComprovante: { type: Type.BOOLEAN },
    valor: { type: Type.NUMBER, nullable: true },
    nomeDestinatario: { type: Type.STRING, nullable: true },
    chaveDestino: { type: Type.STRING, nullable: true },
    instituicao: { type: Type.STRING, nullable: true },
    dataHora: { type: Type.STRING, nullable: true },
  },
  required: ['ehComprovante', 'valor', 'nomeDestinatario', 'chaveDestino', 'instituicao', 'dataHora'],
};

export async function analisarComprovante(bytes: Buffer, mimeType: string): Promise<AnaliseComprovante | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    console.error('[comprovante] GEMINI_API_KEY ausente — sem análise.');
    return null;
  }
  if (bytes.length === 0 || bytes.length > MAX_BYTES) return null;

  const ai = new GoogleGenAI({ apiKey: key });
  const base64 = bytes.toString('base64');
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await ai.models.generateContent({
        model: MODEL,
        contents: [{ role: 'user', parts: [{ text: PROMPT }, { inlineData: { mimeType, data: base64 } }] }],
        config: { responseMimeType: 'application/json', responseSchema: schema, thinkingConfig: { thinkingBudget: 0 } },
      });
      const o = JSON.parse(resp.text ?? '') as Record<string, unknown>;
      return {
        ehComprovante: o.ehComprovante === true,
        valor: typeof o.valor === 'number' && Number.isFinite(o.valor) ? o.valor : null,
        nomeDestinatario: typeof o.nomeDestinatario === 'string' && o.nomeDestinatario.trim() ? o.nomeDestinatario.trim() : null,
        chaveDestino: typeof o.chaveDestino === 'string' && o.chaveDestino.trim() ? o.chaveDestino.trim() : null,
        instituicao: typeof o.instituicao === 'string' && o.instituicao.trim() ? o.instituicao.trim() : null,
        dataHora: typeof o.dataHora === 'string' && o.dataHora.trim() ? o.dataHora.trim() : null,
      };
    } catch (err) {
      lastErr = err;
      const m = err instanceof Error ? err.message : String(err);
      if (isTransient(m) && attempt < 2) {
        await sleep(700 * (attempt + 1));
        continue;
      }
      console.error('[comprovante] falha ao analisar', err);
      return null;
    }
  }
  console.error('[comprovante] falha após retries', lastErr);
  return null;
}
```

- [ ] **Step 2: Script live `scripts/test-comprovante-live.ts`** (valida com um comprovante REAL — ex.: o print que o Murilo usou no teste):

```ts
/**
 * Diagnóstico ao vivo: analisa um comprovante real e mostra o marcador que a
 * Camila veria. Rodar: npx tsx --env-file=.env.local scripts/test-comprovante-live.ts <caminho-imagem-ou-pdf>
 */
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { analisarComprovante } from '../src/lib/comprovante';
import { montarMarcadorComprovante, verificarDestinatario, chaveEsperada } from '../src/lib/comprovante-core';

const MIMES: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.pdf': 'application/pdf' };

async function main() {
  const caminho = process.argv[2];
  if (!caminho) {
    console.error('Uso: npx tsx --env-file=.env.local scripts/test-comprovante-live.ts <arquivo>');
    process.exit(1);
  }
  const mime = MIMES[extname(caminho).toLowerCase()];
  if (!mime) { console.error(`Extensão não suportada: ${caminho}`); process.exit(1); }
  const bytes = readFileSync(caminho);
  console.log(`Analisando ${caminho} (${bytes.length} bytes, ${mime})...`);
  const analise = await analisarComprovante(bytes, mime);
  console.log('\nAnálise:', JSON.stringify(analise, null, 2));
  const verif = analise ? verificarDestinatario(analise, chaveEsperada()) : 'inconclusivo';
  console.log(`\nVerificação do destinatário (esperado: "${chaveEsperada()}"): ${verif}`);
  console.log('\nMarcador que a Camila veria:\n' + montarMarcadorComprovante(analise, verif));
}
main();
```

- [ ] **Step 3: `pnpm build`** → verde.
- [ ] **Step 4: Commit** — `git add src/lib/comprovante.ts scripts/test-comprovante-live.ts && git commit -m "feat: leitura de comprovante Pix via Gemini vision + script de diagnóstico"`

---

### Task 3: Webhook — analisar imagem/documento + backstop + alerta enriquecido

**Files:**
- Modify: `src/app/api/whatsapp/webhook/route.ts`

- [ ] **Step 1: `extractText` passa a analisar a mídia.** Trocar o bloco `if (msg.type === 'image' || msg.type === 'document')` (route.ts:92-99) e a assinatura — a função retorna também o resultado da análise pro backstop/alerta:

```ts
interface ExtractResult {
  texto: string | null;
  /** presente só quando a mensagem era imagem/documento analisado */
  comprovante?: { analise: AnaliseComprovante | null; verificacao: VerificacaoDestinatario };
}

async function extractText(msg: WebhookMessage): Promise<ExtractResult> {
  if (msg.type === 'text') return { texto: msg.text?.body?.trim() || null };
  if (msg.type === 'audio' || msg.type === 'voice') {
    // ... (bloco atual inalterado, retornando { texto: ... })
  }
  if (msg.type === 'image' || msg.type === 'document') {
    const mediaId = msg.image?.id || msg.document?.id;
    const mime = msg.image?.mime_type || msg.document?.mime_type || 'image/jpeg';
    let analise: AnaliseComprovante | null = null;
    if (mediaId) {
      const media = await downloadMedia(mediaId);
      if (media) analise = await analisarComprovante(media.bytes, media.mimeType || mime);
    }
    const verificacao = analise ? verificarDestinatario(analise, chaveEsperada()) : 'inconclusivo';
    const marca = montarMarcadorComprovante(analise, verificacao);
    const caption = (msg.image?.caption || msg.document?.caption)?.trim();
    return { texto: caption ? `${marca} Legenda: ${caption}` : marca, comprovante: { analise, verificacao } };
  }
  return { texto: null };
}
```

Imports novos: `analisarComprovante` de `@/lib/comprovante`; `chaveEsperada, montarMarcadorComprovante, verificarDestinatario` e os types de `@/lib/comprovante-core`.

- [ ] **Step 2: Ajustar o caller no `after()`** — `const texto = await extractText(msg)` vira `const { texto, comprovante } = await extractText(msg)` (route.ts:147; usos de `texto` seguem iguais).

- [ ] **Step 3: Backstop determinístico** — logo após `turno = await computeReply(from)` e antes do handoff (route.ts:188), suprimir `enviarForm` quando ESTE turno era um anexo inválido:

```ts
// Backstop: o modelo marcou enviarForm mas a análise do anexo deste turno diz
// que NÃO é comprovante válido (chave de outro destinatário ou não-comprovante)
// → suprime o handoff por código, independente do que o prompt decidiu.
const anexoInvalido =
  comprovante && (comprovante.verificacao === 'nao_confere' || comprovante.analise?.ehComprovante === false);
if (turno.enviarForm && anexoInvalido) {
  console.warn(`[comprovante] enviarForm suprimido: anexo inválido (verificacao=${comprovante.verificacao}, ehComprovante=${comprovante.analise?.ehComprovante}).`);
  turno = { ...turno, enviarForm: false };
}
```

- [ ] **Step 4: Alerta de handoff reformulado (item 3 do pedido)** — `notifyTeam` ganha parâmetro opcional do comprovante e a mensagem vira uma notificação de trabalho (destinatários seguem vindo de `NOTIFY_ALERT_NUMBERS` — pra chegar no celular pessoal da Camila humana é só adicionar o número dela na env: `railway variable set NOTIFY_ALERT_NUMBERS=...`, sem deploy):

```ts
// call site: await notifyTeam(from, nome, turno, comprovante);

function linhaComprovante(c?: { analise: AnaliseComprovante | null; verificacao: VerificacaoDestinatario }): string {
  if (!c) return '💰 Comprovante: recebido em turno anterior — conferir na conversa.';
  if (!c.analise) return '💰 Comprovante: ⚠️ SEM validação automática — conferir valor e destinatário manualmente.';
  const v = c.analise.valor != null ? `R$ ${c.analise.valor.toFixed(2).replace('.', ',')}` : 'valor não legível';
  const chave = c.verificacao === 'confere' ? 'chave confere ✔' : c.verificacao === 'nao_confere' ? 'CHAVE NÃO CONFERE ⚠️' : 'chave não confirmada ⚠️';
  return `💰 Comprovante: ${v} (${chave})`;
}

// corpo novo do alerta (substitui as `linhas` atuais em notifyTeam):
const linhas = [
  '🩵 *Camila (IA) concluiu mais uma triagem automática!*',
  '',
  `👤 Paciente: ${lead.nome || nome || '(sem nome)'}`,
  `📱 WhatsApp: +${waId}`,
  lead.telefone ? `☎️ Telefone informado: ${lead.telefone}` : null,
  lead.email ? `✉️ E-mail: ${lead.email}` : null,
  lead.disponibilidade ? `🗓️ Horário/disponibilidade: ${lead.disponibilidade}` : null,
  lead.preferenciaAbordagem ? `🧠 Preferência: ${lead.preferenciaAbordagem}` : null,
  lead.resumo ? `📝 Queixa: ${lead.resumo}` : lead.motivacao ? `📝 Motivação: ${lead.motivacao}` : null,
  linhaComprovante(comprovante),
  '📋 Formulário de triagem enviado ao paciente.',
  '',
  '*Próximos passos:*',
  '1️⃣ Conferir o pagamento na conta',
  '2️⃣ Confirmar o preenchimento do formulário',
  '3️⃣ Ajustar o horário no PsicoManager',
  '',
  'A IA está pausada nesse número — a conversa agora é de vocês. 💙',
].filter(Boolean) as string[];
```

- [ ] **Step 5: `pnpm build`** → verde.
- [ ] **Step 6: Commit** — `git add src/app/api/whatsapp/webhook/route.ts && git commit -m "feat: webhook analisa comprovante (valor+destinatário), backstop de handoff e alerta enriquecido"`

---

### Task 4: Prompt v14 — nome completo + regras do comprovante analisado

**Files:**
- Modify: `src/lib/default-prompt.ts`

- [ ] **Step 1: Nome completo** — na seção "O QUE VOCÊ REÚNE", trocar a linha `- Nome completo.` por:

```
- Nome completo. Se a pessoa der um nome que parece incompleto (uma palavra só, ex. "Murilo", ou com abreviação/inicial, ex. "Murilo M"), agradeça e peça UMA vez, com leveza, o nome completo ("pode me passar seu nome completinho? É pra ficha da psicóloga 😊"). Se ela não completar, siga o fluxo normalmente com o que deu — nunca trave a conversa por causa disso.
```

- [ ] **Step 2: Comprovante analisado** — na regra de TOM "IMAGEM / ANEXO" (linha ~23), substituir a frase "Se isso chegar DEPOIS de você já ter combinado o pagamento..." por regras alinhadas ao novo marcador:

```
- **IMAGEM / ANEXO**. Você não vê imagens, mas o sistema ANALISA automaticamente o anexo e te entrega o resultado entre colchetes ("[o paciente enviou uma imagem... Análise automática: ...]"). Siga o veredito do marcador À RISCA:
  · COMPROVANTE detectado + chave CONFERE: confira o VALOR contra a opção combinada na conversa (individual: avulsa R$ 75,00 / pacote R$ 280,00 / quinzenal R$ 150,00; casal: avulsa R$ 150,00 / pacote R$ 550,00). Valor bate → siga o Passo 4 (confirmação + formulário + enviarForm=true). Valor NÃO bate → NÃO confirme e NÃO envie o formulário: aponte a diferença com gentileza ("o comprovante veio de R$ X, mas o combinado foi R$ Y") e peça pra pessoa verificar.
  · Chave NÃO CONFERE: NÃO confirme e NÃO envie o formulário. Diga que o pagamento parece ter ido pra outro destinatário, reenvie os dados corretos do Pix ({PIX_INFO}) e peça pra verificar.
  · NÃO é comprovante: não confirme nada; se o pagamento tinha acabado de ser combinado, peça o comprovante com gentileza; senão, pergunte do que se trata.
  · Análise indisponível: se o pagamento acabou de ser combinado, trate como comprovante recebido e siga o Passo 4 (a equipe confere manualmente). Fora de contexto de pagamento, peça que a pessoa descreva por texto.
  Nunca invente o conteúdo da imagem além do que o marcador diz.
```

- [ ] **Step 3: Passo 4** — no início, trocar "QUANDO O PACIENTE MANDAR O COMPROVANTE DE PAGAMENTO:" por "QUANDO O COMPROVANTE FOR VÁLIDO (comprovante detectado, chave ok/indisponível E valor batendo — ver regra IMAGEM/ANEXO):".

- [ ] **Step 4: Bump** — `PROMPT_VERSION = '2026-07-20-cazule-v14-nome-completo-comprovante-lido'`.
- [ ] **Step 5: Commit** — `git add src/lib/default-prompt.ts && git commit -m "fix: prompt v14 — pede nome completo 1x e valida comprovante analisado (valor+chave)"`

---

### Task 5: Cenários de regressão no `test-triagem.ts`

**Files:**
- Modify: `scripts/test-triagem.ts`

- [ ] **Step 1: Fixture do cenário existente 'comprovante em imagem'** — substituir a fala do marcador cru pela SAÍDA REAL de `montarMarcadorComprovante` (import de `../src/lib/comprovante-core`), garantindo que fixture nunca desvia da produção:

```ts
import { montarMarcadorComprovante } from '../src/lib/comprovante-core';
const ANALISE_OK = { ehComprovante: true, valor: 75, nomeDestinatario: 'Bruna Amorim', chaveDestino: '+55 27 98117-8233', instituicao: 'Nubank', dataHora: '20/07/2026 15:10' };
// na fala final do cenário: montarMarcadorComprovante(ANALISE_OK, 'confere')
```

- [ ] **Step 2: 3 cenários novos**:

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
{
  nome: 'comprovante com VALOR errado -> aponta e NAO envia form',
  falas: [
    'oi, quero agendar uma sessao individual',
    'sou a Carla Dias, ansiedade no trabalho, meu whatsapp e 11 96666-5555, posso quartas a tarde',
    'pode ser quarta as 15h sim',
    'prefiro a sessao avulsa',
    montarMarcadorComprovante({ ...ANALISE_OK, valor: 550 }, 'confere'), // pagou 550, combinado 75
  ],
  checar: (t) => {
    const enviou = t.some((x) => x.res.enviarForm);
    const ultima = t[t.length - 1].res.resposta;
    const apontou = /valor|R\$/i.test(ultima) && /verific|confer|diferen/i.test(ultima);
    return { ok: !enviou && apontou, nota: `enviarForm=${enviou} apontouValor=${apontou} | ultima="${ultima.slice(0, 140)}"` };
  },
},
{
  nome: 'comprovante com CHAVE errada -> nao confirma e reenvia o Pix',
  falas: [
    'oi, quero agendar uma sessao individual',
    'sou a Carla Dias, ansiedade no trabalho, meu whatsapp e 11 96666-5555, posso quartas a tarde',
    'pode ser quarta as 15h sim',
    'prefiro a sessao avulsa',
    montarMarcadorComprovante({ ...ANALISE_OK, chaveDestino: '+55 11 91234-5678' }, 'nao_confere'),
  ],
  checar: (t) => {
    const enviou = t.some((x) => x.res.enviarForm);
    const ultima = t[t.length - 1].res.resposta;
    const avisou = /destinat|outra? (conta|chave)|n[ãa]o confere/i.test(ultima);
    return { ok: !enviou && avisou, nota: `enviarForm=${enviou} avisouDestinatario=${avisou} | ultima="${ultima.slice(0, 140)}"` };
  },
},
```

- [ ] **Step 3: Rodar a suíte completa** — `npx tsx --env-file=.env.local scripts/test-triagem.ts` → **15/15** (12 antigos + 3 novos). Protocolo de flake: falha isolada/campos null → re-rodar 1x.
- [ ] **Step 4: Commit** — `git add scripts/test-triagem.ts && git commit -m "test: nome incompleto + comprovante com valor/chave errados (fixtures da produção)"`

---

### Task 6: `.env.example` + regressão completa + deploy + docs

**Files:**
- Modify: `.env.example` (documentar `PIX_CHAVE` opcional: "só a chave, p/ validação do comprovante; sem ela a chave é derivada da PIX_INFO")
- Modify: `CONTEXTO-CAZULE.md` (Leva 6) + memória do projeto

- [ ] **Step 1: Unit tests puros** — `npx tsx scripts/test-comprovante-core.ts && npx tsx scripts/test-anti-repeat.ts && npx tsx scripts/test-parse-modelo.ts && npx tsx scripts/test-split.ts && npx tsx scripts/test-agenda.ts && npx tsx scripts/test-followup.ts` → todos verdes.
- [ ] **Step 2: Suíte 15/15 + personas** — `test-triagem` 15/15; `sim-conversa passivo` fecha o funil (o fluxo feliz não pode ter regredido).
- [ ] **Step 3: Teste live do comprovante** — se houver um print de comprovante disponível (ex.: o do teste do Murilo), rodar `npx tsx --env-file=.env.local scripts/test-comprovante-live.ts <arquivo>` e conferir valor/chave extraídos. Se não houver arquivo, pular (o teste real de WhatsApp cobre).
- [ ] **Step 4: `pnpm build`** verde → push (`gh auth switch --user vertechsolutions; gh auth setup-git; git push origin master`) → monitorar `railway deployment list` até SUCCESS do commit novo → health 200.
- [ ] **Step 5: Teste real dirigido (Murilo, 49999551051)**: (a) dar nome "Murilo M" → Camila pede completo; (b) fluxo até o Pix e mandar um comprovante com valor/destinatário errados → Camila recusa educadamente, sem form, sem alerta de handoff; (c) comprovante correto → confirmação + form + alerta novo ("Camila (IA) concluiu mais uma triagem automática!" com checklist e linha do comprovante). Logs: `railway logs` procurar `[comprovante]`. (d) Pra chegar no celular da Camila (humana): Murilo passa o número dela → `railway variable set NOTIFY_ALERT_NUMBERS=<lista atual>,<numero>` (sem deploy).
- [ ] **Step 6: Docs** — Leva 6 no `CONTEXTO-CAZULE.md`, memória (`cazule-projeto.md` + integrações: nova env opcional `PIX_CHAVE`, novo log `[comprovante]`), commit docs + push.

---

## Verificação final

- `test-comprovante-core` ✔ (puro) · demais units ✔ · `test-triagem` **15/15** · `sim-conversa passivo` fecha o funil
- Build verde · deploy SUCCESS · health 200
- Real: nome incompleto é pedido 1x; comprovante errado (valor OU chave) não passa; comprovante certo confirma + alerta enriquecido
- Logs: `[comprovante] enviarForm suprimido` só em tentativa inválida; `[comprovante] falha` esporádico é aceitável (fail-open)

## Riscos e mitigação

- **OCR errar contra paciente legítimo**: chave compara por sufixo de dígitos (tolerante a máscara/formato); nome nunca gera "não confere" sozinho (só inconclusivo); análise falhou → fail-open (fluxo atual + equipe confere via alerta ⚠️). O bloqueio duro (backstop) só age nos casos de ALTA confiança (chave claramente outra / não é comprovante).
- **Falso "não é comprovante"** (print exótico): a Camila pede o comprovante de novo; paciente reenvia foto melhor. Sem beco sem saída.
- **Latência**: +1 chamada Gemini por imagem — só quando chega anexo, aceitável.
- **Nome curto legítimo** (ex.: "Ana Sá"): a regra pede completar UMA vez e segue mesmo sem resposta — nunca trava (alinhado à regra existente "não fique presa numa pergunta").
