# Anti-repetição da Camila (bug real da Bruna) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> Ao iniciar a execução, copie este plano para `docs/superpowers/plans/2026-07-20-camila-anti-repeticao.md` (trilha versionada).

**Goal:** Eliminar a repetição verbatim de respostas da Camila (bug reportado pela Bruna em 19/07, conversa +55 61 94756-9216) e a causa-raiz comportamental (quando o paciente devolve a decisão — "seria melhor vocês sugerirem" — ela não decide e trava), sem quebrar nenhuma funcionalidade existente.

**Architecture:** Defesa em 2 camadas + regressão. (1) **Trava determinística** — novo módulo puro `src/lib/anti-repeat.ts` com wrapper `runTriagemSemRepeticao()` sobre `runTriagem()`: compara a resposta gerada com a última mensagem da assistente no histórico (normalização + similaridade Dice); se repetiu, refaz UMA vez com aviso explícito no system. Pega qualquer repetição, independente do prompt. (2) **Prompt v13** — regra de decisão (paciente pede sugestão → Camila sugere UMA abordagem e engata o funil) + reforço do que fazer em vez de repetir. (3) Todos os harnesses (test-triagem, sim-conversa, replay) passam a usar o wrapper — a trava é exercitada em todos os testes.

**Tech Stack:** TypeScript (Next.js 16 lib), `@google/genai` (Gemini 2.5 Flash), scripts `tsx` + `node:assert` (padrão do repo, sem framework de teste).

**Contexto do bug (print da Bruna, 19/07 18:35):**
1. Paciente: "Qual a melhor abordagem pra o nosso caso?" → Camila: "Para o caso de vocês... tanto a TCC quanto a humanista... Vocês preferem alguma delas ou querem que eu sugira uma para começar?"
2. Paciente: "Não entendo, seria melhor vocês sugerirem" → Camila repetiu **a mesma mensagem, idêntica**.
Duas falhas: repetição literal (o prompt v12 já proíbe na regra de TOM, mas regra de LLM é probabilística — falhou em produção com `thinkingBudget: 0`); e comportamental: ela ofereceu "querem que eu sugira?" e, quando o paciente topou, não tinha instrução de DECIDIR — sem nada novo a dizer, colapsou na repetição. A conversa real está no Postgres (`wa_messages`, wa_id ...9216) e o replay a cobrirá automaticamente.

**Por que não quebra nada:** o wrapper só age quando detecta repetição vs a ÚLTIMA mensagem da assistente (limiar alto, 0.9); custo = 1 chamada Gemini extra apenas nesse caso raro. Falso-positivo mais provável (paciente pede pra reenviar o Pix) é coberto pelo aviso do retry: "reenvie os dados, reformulando o texto em volta". Nenhuma assinatura pública muda; `runTriagem` fica intacto.

---

### Task 1: Módulo puro `anti-repeat` (normalização + similaridade + detecção) — TDD

**Files:**
- Create: `src/lib/anti-repeat.ts`
- Test: `scripts/test-anti-repeat.ts`

- [ ] **Step 1: Escrever o teste que falha** — `scripts/test-anti-repeat.ts` (padrão dos outros: tsx + node:assert, sem API, sem env):

```ts
/**
 * Testes do módulo anti-repetição (puro, sem Gemini).
 * Rodar:  npx tsx scripts/test-anti-repeat.ts
 */
import assert from 'node:assert';
import { normalizaComparacao, similaridade, ehRepeticao } from '../src/lib/anti-repeat';

// --- normalizaComparacao ---
assert.strictEqual(normalizaComparacao('  Oi,  TUDO bem?! '), 'oi tudo bem');
assert.strictEqual(normalizaComparacao('a—b (c) "d"'), 'a b c d');

// --- similaridade ---
assert.strictEqual(similaridade('a b c', 'a b c'), 1);
assert.ok(similaridade('a b c d', 'x y z w') < 0.1);
assert.strictEqual(similaridade('', 'a'), 0);

// --- ehRepeticao: o caso REAL do print da Bruna (19/07) ---
const MSG_REAL =
  'Para o caso de vocês, que buscam resolver brigas e melhorar a comunicação, tanto a TCC quanto a abordagem humanista podem ser bem eficazes. A psicanálise também pode ajudar a entender as raízes desses conflitos. Vocês preferem alguma delas ou querem que eu sugira uma para começar?';
assert.ok(ehRepeticao(MSG_REAL, MSG_REAL), 'repetição idêntica deve ser detectada');

// quase igual (pontuação/espaços diferentes) também é repetição
assert.ok(ehRepeticao(MSG_REAL.replace(/\.\s/g, '! '), MSG_REAL), 'quase igual deve ser detectada');

// uma palavra trocada em texto longo continua sendo repetição (>= 0.9)
assert.ok(ehRepeticao(MSG_REAL.replace('eficazes', 'boas'), MSG_REAL));

// resposta genuinamente nova NÃO é repetição
assert.ok(
  !ehRepeticao('Sugiro começarmos pela TCC: ela é ótima pra comunicação e conflitos. Qual o nome de vocês?', MSG_REAL),
  'resposta nova não pode ser flagrada',
);

// sem mensagem anterior → nunca é repetição
assert.ok(!ehRepeticao(MSG_REAL, undefined));

// mensagens curtas legítimas e diferentes não são flagradas
assert.ok(!ehRepeticao('Perfeito, já te chamo por aqui!', 'Qualquer coisa é só me chamar!'));

console.log('test-anti-repeat: todos os asserts passaram ✔');
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx tsx scripts/test-anti-repeat.ts`
Expected: FAIL — `Cannot find module '../src/lib/anti-repeat'`

- [ ] **Step 3: Implementar `src/lib/anti-repeat.ts`** (parte pura; o wrapper vem na Task 2):

```ts
// Trava determinística contra o bug de repetição verbatim (reportado pela Bruna
// em 19/07/2026): regra de prompt é probabilística e falhou em produção; esta
// camada de código garante que a resposta nunca sai igual à anterior.

/** Normaliza pra comparação: minúsculas, sem pontuação, espaços colapsados. */
export function normalizaComparacao(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.,!?;:…"'“”‘’()\[\]{}*_~\-—–\/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Similaridade Dice entre multiconjuntos de palavras (0..1). */
export function similaridade(a: string, b: string): number {
  const ta = normalizaComparacao(a).split(' ').filter(Boolean);
  const tb = normalizaComparacao(b).split(' ').filter(Boolean);
  if (ta.length === 0 || tb.length === 0) return 0;
  const conta = new Map<string, number>();
  for (const t of ta) conta.set(t, (conta.get(t) ?? 0) + 1);
  let comum = 0;
  for (const t of tb) {
    const c = conta.get(t) ?? 0;
    if (c > 0) {
      comum++;
      conta.set(t, c - 1);
    }
  }
  return (2 * comum) / (ta.length + tb.length);
}

/** Acima disso, a resposta nova é considerada repetição da anterior. */
const LIMIAR_REPETICAO = 0.9;

/** true se a resposta nova é igual (ou quase) à mensagem anterior da assistente. */
export function ehRepeticao(nova: string, anterior: string | undefined): boolean {
  if (!anterior) return false;
  const na = normalizaComparacao(nova);
  const nb = normalizaComparacao(anterior);
  if (!na || !nb) return false;
  if (na === nb) return true;
  return similaridade(nova, anterior) >= LIMIAR_REPETICAO;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx tsx scripts/test-anti-repeat.ts`
Expected: `test-anti-repeat: todos os asserts passaram ✔` (exit 0)

- [ ] **Step 5: Commit**

```bash
git add src/lib/anti-repeat.ts scripts/test-anti-repeat.ts
git commit -m "feat: detector determinístico de resposta repetida (bug real 19/07)"
```

---

### Task 2: Wrapper `runTriagemSemRepeticao` (retry com aviso) + integração no `computeReply`

**Files:**
- Modify: `src/lib/anti-repeat.ts` (adicionar wrapper no fim)
- Modify: `src/lib/conversation.ts:156` (trocar a chamada)

- [ ] **Step 1: Adicionar o wrapper em `src/lib/anti-repeat.ts`** (append ao arquivo da Task 1; o `import` vai para o topo do arquivo):

```ts
import { runTriagem, type TriagemInput, type TriagemResult } from './triagem';

const AVISO_RETRY = `

[AVISO DO SISTEMA — só neste turno]: a resposta que você tentou enviar repetia (quase) literalmente a sua última mensagem, e isso é proibido. Gere uma resposta NOVA:
- Se o paciente pediu uma sugestão ou devolveu a decisão pra você ("qual é melhor?", "sugere você"), DECIDA: sugira UMA opção concreta com justificativa curta e emende a próxima etapa do funil.
- Se o paciente pediu pra reenviar uma informação (ex.: dados do Pix, valores), reenvie os dados, mas com o texto em volta reformulado.
- Em qualquer caso: frases diferentes das da sua última mensagem, mais curto, avançando a conversa.`;

/**
 * runTriagem com trava anti-repetição: se a resposta sair igual (ou quase) à
 * última mensagem da assistente no histórico, refaz UMA única vez com o aviso
 * acima no system. Se ainda assim repetir, loga e devolve a segunda tentativa
 * (nunca entra em loop de chamadas).
 */
export async function runTriagemSemRepeticao(input: TriagemInput): Promise<TriagemResult> {
  const anterior = [...input.messages].reverse().find((m) => m.role === 'assistant')?.content;
  const primeira = await runTriagem(input);
  if (!ehRepeticao(primeira.resposta, anterior)) return primeira;
  console.warn('[anti-repeat] resposta repetiu a anterior — refazendo com aviso');
  const segunda = await runTriagem({ ...input, system: input.system + AVISO_RETRY });
  if (ehRepeticao(segunda.resposta, anterior)) {
    console.error('[anti-repeat] repetição persistiu após retry — enviando a 2ª tentativa mesmo assim');
  }
  return segunda;
}
```

(Sem dependência circular: `triagem.ts` não importa `anti-repeat.ts`.)

- [ ] **Step 2: Trocar a chamada em `src/lib/conversation.ts`**

Em `computeReply` (linha 156): `const result = await runTriagem({ system, messages: history });` → `const result = await runTriagemSemRepeticao({ system, messages: history });`
No import (linha 2): `runTriagem` deixa de ser usado; importar `runTriagemSemRepeticao` de `./anti-repeat` e manter `type LeadExtraido` de `./triagem`.

- [ ] **Step 3: Typecheck/build**

Run: `pnpm build`
Expected: build verde, sem erros de tipo.

- [ ] **Step 4: Commit**

```bash
git add src/lib/anti-repeat.ts src/lib/conversation.ts
git commit -m "feat: retry automático quando a resposta repete a anterior (computeReply)"
```

---

### Task 3: Prompt v13 — decidir quando o paciente devolve a decisão (causa-raiz)

**Files:**
- Modify: `src/lib/default-prompt.ts`

- [ ] **Step 1: Regra de decisão na seção ABORDAGENS DISPONÍVEIS** (após a linha "Se a pessoa não souber qual quer..."), adicionar:

```
- Se a pessoa pedir que VOCÊ sugira, ou perguntar "qual é melhor pro meu/nosso caso?": NÃO devolva a pergunta ("prefere qual?" / "quer que eu sugira?") — SUGIRA UMA na hora, com justificativa leve e sem linguagem clínica (ex.: pra conflitos e comunicação no casal, a TCC costuma ser um ótimo começo — e dá pra ajustar com a psicóloga depois). Você pode oferecer a escolha ("prefere alguma ou quer que eu sugira?") NO MÁXIMO UMA VEZ na conversa; se a pessoa devolver a decisão ou não escolher, DECIDA você e emende a próxima etapa do funil na mesma mensagem (nome, disponibilidade...).
```

- [ ] **Step 2: Reforço na regra de TOM anti-repetição** (linha 14, "NUNCA envie a mesma mensagem..."), acrescentar ao final da regra:

```
Se perceber que ia dizer de novo a mesma coisa, a conversa travou: mude a tática — decida você, responda mais curto com outras palavras e AVANCE a próxima etapa do funil.
```

- [ ] **Step 3: Bump da versão** — `PROMPT_VERSION = '2026-07-20-cazule-v13-decide-e-nao-repete'`

- [ ] **Step 4: Commit**

```bash
git add src/lib/default-prompt.ts
git commit -m "fix: prompt v13 — paciente devolveu a decisão => Camila sugere UMA abordagem e avança"
```

---

### Task 4: Harnesses usam a trava + cenário de regressão do bug real

**Files:**
- Modify: `scripts/test-triagem.ts` (usar wrapper + novo cenário)
- Modify: `scripts/sim-conversa.ts` (usar wrapper + persona indecisa)
- Modify: `scripts/replay-conversas.ts` (usar wrapper)

- [ ] **Step 1: Trocar `runTriagem` → `runTriagemSemRepeticao`** nos 3 scripts (import de `../src/lib/anti-repeat`; manter os types de `../src/lib/triagem`). Assim a trava é exercitada em TODA simulação/replay, não só em produção.

- [ ] **Step 2: Novo cenário em `scripts/test-triagem.ts`** (reproduz a conversa da amiga da Bruna; import adicional: `ehRepeticao` de `../src/lib/anti-repeat`):

```ts
{
  nome: 'devolveu a decisão -> Camila SUGERE uma abordagem e não repete (bug 19/07)',
  falas: [
    'oi, é pra terapia de casal',
    'nosso maior problema são as brigas',
    'qual a melhor abordagem pra o nosso caso?',
    'não entendo, seria melhor vocês sugerirem',
  ],
  checar: (t) => {
    const ultima = t[t.length - 1].res.resposta;
    const penultima = t[t.length - 2].res.resposta;
    const repetiu = ehRepeticao(ultima, penultima);
    const sugeriu = /tcc|cognitivo|humanist|psican/i.test(ultima);
    const devolveuPergunta = /vocês preferem|voces preferem|prefere alguma|quer(em)? que eu sugira/i.test(ultima);
    return {
      ok: !repetiu && sugeriu && !devolveuPergunta,
      nota: `repetiu=${repetiu} sugeriuAbordagem=${sugeriu} devolveuPergunta=${devolveuPergunta} | ultima="${ultima.slice(0, 140)}"`,
    };
  },
},
```

- [ ] **Step 3: Persona indecisa em `scripts/sim-conversa.ts`** (adicionar à lista `personas`):

```ts
const PACIENTE_INDECISO: Persona = {
  nome: 'paciente-indeciso-devolve-decisoes (anti-repetição)',
  system: `Você simula uma PACIENTE no WhatsApp de uma clínica de psicologia buscando TERAPIA DE CASAL.
Persona: Paula, 31 anos, casada, brigas constantes com o marido. Ela NUNCA decide nada sozinha:
sempre que a atendente oferecer opções ou perguntar preferência, devolva a decisão com variações de
"não sei, o que você acha melhor?", "seria melhor você sugerir", "tanto faz, me indica você".
Se a atendente sugerir algo concreto (uma abordagem, um horário), aceite ("pode ser esse então").
Escreva curto, PT-BR, uma mensagem por vez. Responda SOMENTE com a próxima fala, sem aspas.`,
  maxTurnos: 8,
  encerra: () => false,
  comAgenda: true,
};
```

Critério de inspeção manual da transcrição: nenhuma resposta da Camila igual/quase igual à anterior; quando a Paula devolve a decisão, a Camila decide e o funil avança.

- [ ] **Step 4: Rodar o cenário novo isolado primeiro, depois a suíte**

Run: `npx tsx --env-file=.env.local scripts/test-triagem.ts`
Expected: **12/12 cenários** (11 antigos + o novo). Protocolo de flake do projeto: cenário com campos null aleatórios ou falha isolada → rodar 1x de novo antes de tratar como regressão.

Run: `npx tsx --env-file=.env.local scripts/sim-conversa.ts indeciso`
Expected: transcrição sem repetições; Camila sugere e avança.

- [ ] **Step 5: Commit**

```bash
git add scripts/test-triagem.ts scripts/sim-conversa.ts scripts/replay-conversas.ts
git commit -m "test: cenário do bug de repetição (19/07) + persona indecisa + trava nos harnesses"
```

---

### Task 5: Regressão completa (garantir que nada quebrou)

**Files:** nenhum novo — só execução.

- [ ] **Step 1: Unit tests puros**

Run: `npx tsx scripts/test-anti-repeat.ts && npx tsx scripts/test-split.ts && npx tsx scripts/test-agenda.ts && npx tsx scripts/test-followup.ts`
Expected: todos exit 0.

- [ ] **Step 2: Suíte de triagem completa**

Run: `npx tsx --env-file=.env.local scripts/test-triagem.ts`
Expected: 12/12.

- [ ] **Step 3: Personas críticas do funil** (validam o pipeline de ponta a ponta)

Run: `npx tsx --env-file=.env.local scripts/sim-conversa.ts passivo` e `npx tsx --env-file=.env.local scripts/sim-conversa.ts casal`
Expected: passivo fecha o funil inteiro (enviarForm=true) sem travar; casal recebe 150/550 e as 3 etapas.

- [ ] **Step 4: Replay da conversa REAL do bug** — a conversa da amiga (61 94756-9216) está no Postgres de produção:

```powershell
# pegar a URL pública (read-only, não vai pra env do app)
railway variable list -s Postgres --json   # copiar DATABASE_PUBLIC_URL
$env:DATABASE_PUBLIC_URL = "<valor>"; npx tsx --env-file=.env.local scripts/replay-conversas.ts
```

Expected: no replay da conversa ...9216, o turno "Não entendo, seria melhor vocês sugerirem" recebe resposta NOVA (diferente da anterior) com sugestão concreta. Nenhuma outra conversa regride (comparar ANTIGA vs NOVA a olho + avaliação Fable se algo parecer estranho).

- [ ] **Step 5: Build final**

Run: `pnpm build`
Expected: verde.

---

### Task 6: Deploy + verificação em produção

**Files:** nenhum — git/Railway.

- [ ] **Step 1: Push (auto-deploy)** — só com Task 5 toda verde:

```powershell
gh auth switch --user vertechsolutions; gh auth setup-git; git push origin master
```

- [ ] **Step 2: Monitorar o deploy** — `railway deployment list` até o deployment do commit novo ficar SUCCESS (conferir a mensagem do commit no topo, não confiar no primeiro SUCCESS listado). Depois: `curl https://clinica-psi-crm-production.up.railway.app/api/health` → 200.

- [ ] **Step 3: Teste real dirigido** — repetir a conversa do print no número de teste: "é pra casal" → "brigas" → "qual a melhor abordagem?" → "seria melhor vocês sugerirem". Esperado: sugestão concreta, sem repetição. Conferir logs: `railway logs` sem `[anti-repeat] repetição persistiu`.

- [ ] **Step 4: Documentar** — adicionar "Leva 5" curta no `CONTEXTO-CAZULE.md` (bug do print, 2 camadas, v13) + atualizar memória `cazule-projeto.md`; gerar bloco curto em md pra responder a Bruna ("corrigido + trava que impede repetição por construção"). Commit docs (não redeploya — fora dos watchPatterns).

```bash
git add CONTEXTO-CAZULE.md docs/superpowers/plans/2026-07-20-camila-anti-repeticao.md
git commit -m "docs: leva 5 — anti-repetição (bug real 19/07) + plano"
git push origin master
```

---

## Verificação final (checklist)

- `npx tsx scripts/test-anti-repeat.ts` verde (puro, sem API)
- `test-split` / `test-agenda` / `test-followup` verdes (nada quebrou)
- `test-triagem` **12/12** (11 antigos intactos + cenário do bug)
- `sim-conversa passivo` fecha o funil inteiro; `casal` ok; `indeciso` sem repetição e com decisão
- Replay da conversa real ...9216: turno do bug responde com sugestão nova
- `pnpm build` verde; deploy SUCCESS; health 200; teste real no WhatsApp sem repetição
- Logs de produção: `[anti-repeat]` warn é aceitável (trava agindo); `persistiu` não pode aparecer

## Riscos e mitigação

- **Falso-positivo** (paciente pede pra reenviar Pix/valores): limiar 0.9 + comparação só com a última mensagem + aviso do retry manda reenviar os dados reformulando o texto. Pior caso: mesma informação com outras palavras — UX correta.
- **Retry também repete**: probabilidade mínima (aviso explícito + temperatura); loga `[anti-repeat] persistiu` pra monitorar. Não itera mais de 1x (sem loop de custo).
- **Prompt v13 desestabilizar outros fluxos**: mudanças são cirúrgicas (2 acréscimos, zero remoção); regressão 12/12 + personas + replay cobrem os fluxos das levas anteriores.
