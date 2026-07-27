# Leva 9 — Agenda real: parser da planilha nova + trava anti-conflito (plano de implementação)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) ou superpowers:executing-plans. Os passos usam checkbox (`- [ ]`).

**Goal:** a Camila volta a enxergar a agenda real (hoje dá Sheets 400 e ela inventa psicóloga), propondo horário concreto de profissional que existe — e dois pacientes não conseguem fechar o mesmo horário.

**Architecture:** o `sheets.ts` descobre as abas da planilha em runtime em vez de assumir nomes fixos; o `agenda-core.ts` ganha um parser tolerante para o formato "uma aba por psicóloga, um horário de início por célula"; o resumo injetado no prompt passa a listar horários concretos. Depois, uma tabela `agendamentos` com `UNIQUE (data, hora, psicologa)` transforma o fechamento num claim atômico.

**Tech Stack:** TypeScript, Google Sheets API v4 (Service Account/JWT), Postgres (`pg`), Gemini.

**Spec:** `docs/superpowers/specs/2026-07-27-agenda-planilha-real-design.md`

**Ordem:** rodar DEPOIS da Leva 11 (`2026-07-27-camila-fechamento-e-retomada.md`). A Parte A (Tasks 1–6) é deployável sozinha e já resolve a alucinação de psicóloga.

---

## Parte A — a agenda volta a funcionar

### Task 1: Normalização de horário (função pura)

**Files:**
- Modify: `src/lib/agenda-core.ts`
- Test: `scripts/test-agenda.ts`

- [ ] **Step 1: Escrever os asserts que falham**

Adicionar no fim de `scripts/test-agenda.ts` (antes do `console.log` final), e incluir `normalizaHora` no import de `../src/lib/agenda-core`:

```ts
// normalizaHora: tolera a sujeira real da planilha da Bruna (dump de 27/07/2026)
assert.equal(normalizaHora('10:00'), '10:00');
assert.equal(normalizaHora('8:00'), '08:00');      // sem zero à esquerda
assert.equal(normalizaHora('11;00'), '11:00');     // typo real
assert.equal(normalizaHora('13;00'), '13:00');     // typo real
assert.equal(normalizaHora('08:0'), '08:00');      // typo real
assert.equal(normalizaHora('13h'), '13:00');
assert.equal(normalizaHora(' 15:15 '), '15:15');   // horário quebrado legítimo
assert.equal(normalizaHora('19:45'), '19:45');
assert.equal(normalizaHora('-'), null);            // "não atende"
assert.equal(normalizaHora('0'), null);            // célula solta
assert.equal(normalizaHora(''), null);
assert.equal(normalizaHora('Psicóloga'), null);    // cabeçalho
assert.equal(normalizaHora('25:00'), null);        // hora inválida
assert.equal(normalizaHora('10:70'), null);        // minuto inválido
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx tsx scripts/test-agenda.ts`
Expected: FAIL — `normalizaHora is not a function` (ou erro de import).

- [ ] **Step 3: Implementar**

Adicionar em `src/lib/agenda-core.ts`, logo abaixo dos helpers `cell`/`sim`/`limpa`:

```ts
/**
 * Normaliza uma célula de horário da planilha pra "HH:MM", ou null se não for
 * hora. Tolera a sujeira real da planilha da Bruna: "11;00", "08:0", "8:00",
 * "13h", espaços. Descarta "-", "0", cabeçalhos e horas inválidas.
 */
export function normalizaHora(bruto: string): string | null {
  const s = (bruto ?? '').toString().trim();
  if (!s || s === '-') return null;
  const m = s.match(/^(\d{1,2})\s*[:;.h]\s*(\d{0,2})$/i);
  if (!m) return null;
  const h = Number(m[1]);
  // "08:0" -> 00 ; "8:3" -> 30 (o dígito solto é a dezena do minuto)
  const min = m[2] === '' ? 0 : Number(m[2].padEnd(2, '0'));
  if (!Number.isInteger(h) || !Number.isInteger(min)) return null;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** Compara textos da planilha ignorando caixa, acento e espaços sobrando. */
export function normalizaTexto(s: string): string {
  return (s ?? '')
    .toString()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx tsx scripts/test-agenda.ts`
Expected: `test-agenda: todos os asserts passaram ✔`

- [ ] **Step 5: Commit**

```bash
git add src/lib/agenda-core.ts scripts/test-agenda.ts
git commit -m "feat: normalizaHora tolerante aos typos reais da planilha"
```

---

### Task 2: Parser da aba por psicóloga

**Files:**
- Modify: `src/lib/agenda-core.ts`
- Test: `scripts/test-agenda.ts`

- [ ] **Step 1: Escrever os asserts que falham**

Adicionar em `scripts/test-agenda.ts` (e incluir `parseGradeDeAba`, `casaAbaComPsicologa` no import):

```ts
// parseGradeDeAba: dump real da aba "Talita " (27/07/2026), com typo e buracos
const abaTalita = [
  ['Psicóloga', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'],
  ['', '10:00', '', '10:00', '13:00', '11:15'],
  ['', '11:00', '', '11;00', '14:00', '13:00'],
  ['', '', '', '13:00', '15:00', '14:00'],
];
const gTalita = parseGradeDeAba('Talita de Souza', abaTalita);
assert.equal(gTalita.nome, 'Talita de Souza');
assert.deepEqual(gTalita.horarios.Terça, ['10:00', '11:00']);
assert.deepEqual(gTalita.horarios.Quinta, ['10:00', '11:00', '13:00'], 'typo 11;00 vira 11:00');
assert.deepEqual(gTalita.horarios.Sexta, ['13:00', '14:00', '15:00']);
assert.equal(gTalita.horarios.Segunda, undefined, 'dia sem horário não entra');

// cabeçalho errado (a aba "Mery Helen" tem "Bruna Ferreira" em A1) não atrapalha:
// o mapeamento é pelas COLUNAS de dia, e o nome vem de fora
const abaMery = [
  ['Bruna Ferreira', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'],
  ['', '13:00', '08:00', '08:00', '08:00', '08:00', '-'],
  ['', '13:45', '08:45', '09:45', '08:45', '08:45'],
];
const gMery = parseGradeDeAba('Mery Helen', abaMery);
assert.equal(gMery.nome, 'Mery Helen', 'nome vem do parâmetro, não do A1');
assert.deepEqual(gMery.horarios.Segunda, ['13:00', '13:45']);
assert.equal(gMery.horarios.Sábado, undefined, '"-" não vira horário');

// duplicata e desordem: sai ordenado e único
const abaBagunca = [
  ['Psicóloga', 'Segunda'],
  ['', '14:00'],
  ['', '09:00'],
  ['', '14:00'],
  ['', '0'],
];
assert.deepEqual(parseGradeDeAba('X', abaBagunca).horarios.Segunda, ['09:00', '14:00']);

// casaAbaComPsicologa: título com espaço sobrando, acento e só o primeiro nome
assert.equal(casaAbaComPsicologa('Talita ', 'Talita de Souza'), true);
assert.equal(casaAbaComPsicologa('Mery Helen', 'Mery Helen'), true);
assert.equal(casaAbaComPsicologa('gabriela goulart', 'Gabriela Goulart'), true);
assert.equal(casaAbaComPsicologa('Agenda', 'Talita de Souza'), false);
assert.equal(casaAbaComPsicologa('Instruções', 'Mery Helen'), false);
assert.equal(casaAbaComPsicologa('', 'Mery Helen'), false);
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx tsx scripts/test-agenda.ts`
Expected: FAIL — `parseGradeDeAba is not a function`.

- [ ] **Step 3: Implementar**

Em `src/lib/agenda-core.ts`, trocar a interface `GradeRow` por:

```ts
/**
 * Horários livres de uma psicóloga, por dia da semana. Vem de UMA aba da planilha
 * (a Bruna mantém uma aba por profissional, cada célula é um horário de início).
 */
export interface GradeHorarios {
  nome: string;
  horarios: Partial<Record<Dia, string[]>>;
}
```

Trocar `grade: GradeRow[]` por `grade: GradeHorarios[]` em `AgendaData`, remover `parseGrade` (o formato "Grade Semanal" não existe mais) e adicionar:

```ts
/**
 * Lê uma aba de psicóloga: a linha 1 diz qual coluna é cada dia; cada célula das
 * linhas seguintes é um horário de início. O nome vem de FORA (do cadastro da aba
 * "Psicólogas") porque o A1 da aba pode estar com resíduo do modelo.
 */
export function parseGradeDeAba(nome: string, rows: string[][]): GradeHorarios {
  const header = rows[0] ?? [];
  const colunaDoDia = new Map<number, Dia>();
  header.forEach((h, i) => {
    const dia = DIAS.find((d) => normalizaTexto(d) === normalizaTexto(h));
    if (dia) colunaDoDia.set(i, dia);
  });

  const acc: Partial<Record<Dia, string[]>> = {};
  for (const row of rows.slice(1)) {
    for (const [i, dia] of colunaDoDia) {
      const hora = normalizaHora(cell(row, i));
      if (!hora) continue;
      (acc[dia] ??= []).push(hora);
    }
  }
  const horarios: Partial<Record<Dia, string[]>> = {};
  for (const d of DIAS) {
    const lista = acc[d];
    if (lista?.length) horarios[d] = [...new Set(lista)].sort();
  }
  return { nome, horarios };
}

/**
 * A aba é a grade desta psicóloga? Casa por nome completo ou pelo primeiro nome
 * (a Bruna nomeou a aba da "Talita de Souza" como "Talita "), ignorando caixa,
 * acento e espaço sobrando.
 */
export function casaAbaComPsicologa(tituloAba: string, nomePsicologa: string): boolean {
  const a = normalizaTexto(tituloAba);
  const p = normalizaTexto(nomePsicologa);
  if (!a || !p) return false;
  if (a === p) return true;
  const primeiroA = a.split(' ')[0];
  const primeiroP = p.split(' ')[0];
  return primeiroA.length >= 3 && primeiroA === primeiroP;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx tsx scripts/test-agenda.ts`
Expected: os asserts novos passam. Os asserts antigos que usavam `parseGrade`/`janelas` vão falhar — é esperado; a Task 3 os reescreve.

- [ ] **Step 5: Commit**

```bash
git add src/lib/agenda-core.ts scripts/test-agenda.ts
git commit -m "feat: parseGradeDeAba — uma aba por psicologa, horarios de inicio"
```

---

### Task 3: Resumo com horários concretos

**Files:**
- Modify: `src/lib/agenda-core.ts` (`resumoDisponibilidade`)
- Test: `scripts/test-agenda.ts` (reescrever os asserts de resumo)

- [ ] **Step 1: Escrever os asserts**

Substituir, em `scripts/test-agenda.ts`, os asserts que montavam `grade` com `janelas` por:

```ts
const DADOS = {
  psicologas: [
    { nome: 'Talita de Souza', crp: 'CRP 12/28011', abordagens: 'Gestalt Terapia', individual: true, casal: false, infanto: true, prefGenero: 'F', obs: '' },
    { nome: 'Emanuelle Felix', crp: 'CRP 16/11151', abordagens: 'Junguiana', individual: false, casal: true, infanto: false, prefGenero: 'F/M', obs: '' },
  ],
  grade: [
    { nome: 'Talita de Souza', horarios: { Terça: ['10:00', '11:00'], Quinta: ['13:00'] } },
    { nome: 'Emanuelle Felix', horarios: { Segunda: ['11:00', '12:00'] } },
  ],
  agenda: [
    { data: '30/07/2026', hora: '10:00', paciente: 'X', whatsapp: '', psicologa: 'Talita de Souza', modalidade: 'Individual', tipo: 'Avulsa', status: 'Confirmada', valor: '75', pagamento: 'Pix', nf: 'Não', obs: '' },
  ],
};
const resumo = resumoDisponibilidade(DADOS, { hoje: new Date(2026, 6, 27) });

assert.ok(/AGENDA DA CL[ÍI]NICA/.test(resumo), 'tem o cabeçalho do bloco');
assert.ok(/Talita de Souza/.test(resumo) && /ter 10:00, 11:00/.test(resumo), 'lista horários concretos');
assert.ok(/só atende pacientes mulheres/i.test(resumo), 'restrição de gênero da Talita aparece');
assert.ok(/Emanuelle Felix[^\n]*casal/.test(resumo), 'tags de modalidade por psicóloga');
assert.ok(!/Emanuelle Felix[^\n]*individual/.test(resumo), 'Emanuelle NÃO atende individual');
assert.ok(/Já reservado[\s\S]*30\/07\/2026 10:00 Talita/.test(resumo), 'reserva futura aparece');
assert.ok(/pr[óo]ximo dia [úu]til/i.test(resumo), 'regra de antecedência da Bruna');

// psicóloga sem aba de horários (a Joseane saiu da agenda) não aparece
const semGrade = resumoDisponibilidade(
  { ...DADOS, grade: [DADOS.grade[0]] },
  { hoje: new Date(2026, 6, 27) },
);
assert.ok(!/Emanuelle/.test(semGrade), 'quem não tem horários não é oferecida');
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx tsx scripts/test-agenda.ts`
Expected: FAIL nos asserts novos (o resumo ainda fala em janelas).

- [ ] **Step 3: Implementar**

Em `resumoDisponibilidade`, trocar a construção de `linhas` por:

```ts
  const gradeByNome = new Map(grade.map((g) => [normalizaTexto(g.nome), g.horarios]));

  const linhas = psicologas
    .map((p) => {
      const h = gradeByNome.get(normalizaTexto(p.nome)) ?? {};
      const dias = DIAS.filter((d) => h[d]?.length).map((d) => `${d.slice(0, 3).toLowerCase()} ${(h[d] as string[]).join(', ')}`);
      if (!dias.length) return null;
      const tags = [
        p.individual ? 'individual' : null,
        p.casal ? 'casal' : null,
        p.infanto ? 'infanto 13+' : null,
      ]
        .filter(Boolean)
        .join(', ');
      // "F" na coluna de preferência = só atende mulheres (regra da Talita).
      const g = p.prefGenero.trim().toUpperCase();
      const genero = g === 'F' ? '; só atende pacientes mulheres' : g === 'M' ? '; só atende pacientes homens' : '';
      return `- ${limpa(p.nome)} (${limpa(p.abordagens)}; atende: ${tags || 'a confirmar'}${genero}): ${dias.join('; ')}`;
    })
    .filter((x): x is string => Boolean(x));
```

E acrescentar a regra de antecedência logo depois de `linhaHoje` no array de retorno:

```ts
    'Agende sempre a partir do PRÓXIMO DIA ÚTIL (nunca hoje, nunca no mesmo dia).',
```

E atualizar a linha "Psicólogas, o que cada uma atende e janelas fixas:" para:

```ts
    'Psicólogas, o que cada uma atende e os horários LIVRES (hora de início da sessão, toda semana):',
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx tsx scripts/test-agenda.ts`
Expected: `test-agenda: todos os asserts passaram ✔`

- [ ] **Step 5: Commit**

```bash
git add src/lib/agenda-core.ts scripts/test-agenda.ts
git commit -m "feat: bloco da agenda lista horarios concretos + restricao de genero"
```

---

### Task 4: `sheets.ts` descobre as abas

**Files:**
- Modify: `src/lib/sheets.ts`

- [ ] **Step 1: Substituir a constante de abas fixas**

Trocar:

```ts
const ABAS = ['Psicólogas', 'Grade Semanal', 'Agenda'] as const;
```

por:

```ts
const ABA_PSICOLOGAS = 'Psicólogas';
const ABA_AGENDA = 'Agenda';
```

E ajustar o import de `./agenda-core` para trazer `parseGradeDeAba` e `casaAbaComPsicologa` no lugar de `parseGrade`.

- [ ] **Step 2: Reescrever `fetchAgendaData`**

Substituir o corpo a partir da criação do JWT:

```ts
  const jwt = new JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const { token } = await jwt.getAccessToken();
  if (!token) throw new Error('sem access token da service account');
  const headers = { Authorization: `Bearer ${token}` };

  // 1) Descobre as abas que existem HOJE. Pedir um range inexistente derruba o
  // batchGet inteiro com 400 — foi o que quebrou a agenda quando a Bruna trocou
  // "Grade Semanal" por uma aba por psicóloga.
  const metaRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=sheets.properties.title`,
    { headers },
  );
  if (!metaRes.ok) throw new Error(`Sheets API ${metaRes.status} (metadados)`);
  const meta = (await metaRes.json()) as { sheets?: Array<{ properties?: { title?: string } }> };
  const titulos = (meta.sheets ?? []).map((s) => s.properties?.title ?? '').filter(Boolean);

  const pedir = async (ranges: string[]) => {
    const qs = ranges.map((r) => `ranges=${encodeURIComponent(r)}`).join('&');
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values:batchGet?${qs}`, { headers });
    if (!res.ok) throw new Error(`Sheets API ${res.status}`);
    const json = (await res.json()) as { valueRanges?: Array<{ values?: string[][] }> };
    return json.valueRanges ?? [];
  };

  // 2) Cadastro + agenda (só as que existirem).
  const base = [ABA_PSICOLOGAS, ABA_AGENDA].filter((t) => titulos.some((x) => x.trim() === t));
  const vrBase = base.length ? await pedir(base) : [];
  const idxPsi = base.indexOf(ABA_PSICOLOGAS);
  const idxAge = base.indexOf(ABA_AGENDA);
  const psicologas = parsePsicologas(idxPsi >= 0 ? (vrBase[idxPsi]?.values ?? []) : []);
  const agenda = parseAgenda(idxAge >= 0 ? (vrBase[idxAge]?.values ?? []) : []);

  // 3) Uma aba por psicóloga: casa título de aba com o cadastro.
  const abasDeGrade = psicologas
    .map((p) => ({ p, titulo: titulos.find((t) => casaAbaComPsicologa(t, p.nome)) }))
    .filter((x): x is { p: typeof psicologas[number]; titulo: string } => Boolean(x.titulo));
  const semAba = psicologas.filter((p) => !abasDeGrade.some((x) => x.p.nome === p.nome));
  if (semAba.length) {
    console.warn(`[sheets] sem aba de horários (não serão oferecidas): ${semAba.map((p) => p.nome).join(', ')}`);
  }
  const vrGrade = abasDeGrade.length ? await pedir(abasDeGrade.map((x) => x.titulo)) : [];
  const grade = abasDeGrade.map((x, i) => parseGradeDeAba(x.p.nome, vrGrade[i]?.values ?? []));

  const data: AgendaData = { psicologas, grade, agenda };
  g.__cazuleAgendaCache = { at: Date.now(), data };
  return data;
```

- [ ] **Step 3: Rodar contra a planilha real**

Run: `npx tsx --env-file=.env.local scripts/test-sheets-live.ts`
Expected: sai o bloco `[AGENDA DA CLÍNICA ...]` com Talita, Gabriela, Emanuelle e Mery Helen e seus horários; warning listando a Joseane (sem aba). **Nenhum** `Sheets API 400`.

- [ ] **Step 4: Commit**

```bash
git add src/lib/sheets.ts
git commit -m "fix: agenda 400 — descobre as abas em runtime em vez de nomes fixos"
```

---

### Task 5: Consertar a fixture do harness com Gemini

**Files:**
- Modify: `scripts/test-triagem.ts:48-61` (AGENDA_FAKE)

- [ ] **Step 1: Trocar as janelas por horários**

Substituir o bloco `grade:` do `AGENDA_FAKE` por:

```ts
    grade: [
      { nome: 'Bruna Ferreira', horarios: { Segunda: ['14:00', '15:00', '16:00'], Terça: ['14:00', '15:00'], Quinta: ['14:00', '15:00', '18:00'] } },
      { nome: 'Fernanda Alves', horarios: { Quarta: ['13:00', '14:00', '15:00'], Sexta: ['13:00', '14:00'] } },
    ],
```

- [ ] **Step 2: Rodar a suíte**

Run: `npx tsx --env-file=.env.local scripts/test-triagem.ts`
Expected: mesmo patamar de antes (≥ 22/25). Os cenários de agendamento continuam fechando — agora com horário exato em vez de janela.

- [ ] **Step 3: Commit**

```bash
git add scripts/test-triagem.ts
git commit -m "test: fixture da agenda no formato novo (horarios concretos)"
```

---

### Task 6: Limpeza da planilha e deploy da Parte A

Passos manuais na planilha `1kyEe0-2SN9a0QaZt1evQcnG4B-Qx1g8B9dKNhsBN_3k` (a Bruna é Editora; avisar antes de mexer).

- [ ] **Step 1: Apagar os dados de exemplo da aba "Agenda"**

Remover as 5 linhas de exemplo (Mariana Silva, João Pereira, Ana e Rodrigo, Larissa Rocha, Pedro Amorim). São elas que injetam as psicólogas fictícias "Bruna Ferreira", "Débora Lima", "Fernanda Alves", "Camila Rocha" e "Patrícia Nunes" no contexto da Camila.

- [ ] **Step 2: Corrigir o A1 da aba "Mery Helen"**

Está `Bruna Ferreira`; trocar por `Psicóloga` (só cosmético — o parser usa o nome do cadastro —, mas evita confundir quem abrir a planilha).

- [ ] **Step 3: Corrigir os typos**

`11;00` (Talita/Quarta), `13;00` (Gabriela/Terça), `14;00` e `15;00` (Emanuelle/Terça), `08:0` (Emanuelle/Quarta), e a célula solta `0` no fim da aba da Emanuelle. O parser tolera todos, mas corrigir evita ambiguidade futura.

- [ ] **Step 4: Confirmar com a Bruna**

Perguntar: (a) a Joseane sai mesmo da agenda? (ela ia confirmar com a profissional); (b) a Talita atende só mulheres — confirmar que é isso que a coluna `F` significa; (c) a aba "Instruções" ainda descreve o formato antigo ("Grade Semanal") — atualizar o texto.

- [ ] **Step 5: Deploy**

```bash
gh auth switch --user vertechsolutions && gh auth setup-git && git push origin master
curl -s https://clinica-psi-crm-production.up.railway.app/api/health
```
Expected: health 200 e, no primeiro atendimento, a Camila propondo horário real.

- [ ] **Step 6: Verificar em produção**

Mandar "oi, quero agendar individual, prefiro quinta à tarde" pelo número de teste e conferir que o horário e a psicóloga existem na planilha.

---

## Parte B — trava contra dupla marcação

### Task 7: Tabela `agendamentos`

**Files:**
- Modify: `src/lib/schema.ts`

- [ ] **Step 1: Adicionar o DDL**

Depois do bloco de `app_config` em `initSchema`:

```ts
    // Reserva de horário: UNIQUE (data, hora, psicologa) é a trava contra dois
    // pacientes fecharem o mesmo slot. O INSERT acontece no turno do handoff.
    await client.query(`
      CREATE TABLE IF NOT EXISTS agendamentos (
        id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        data        DATE NOT NULL,
        hora        TEXT NOT NULL,
        psicologa   TEXT NOT NULL,
        wa_id       TEXT NOT NULL,
        paciente    TEXT,
        modalidade  TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (data, hora, psicologa)
      );
    `);
```

- [ ] **Step 2: Subir local e conferir**

Run: `npm run dev` e abrir `http://localhost:3000/api/health`
Expected: 200 (o `initSchema` roda no boot via `instrumentation.ts`); depois confirmar no banco:

```sql
\d agendamentos
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/schema.ts
git commit -m "feat: tabela agendamentos com UNIQUE(data, hora, psicologa)"
```

---

### Task 8: Slot estruturado na saída da triagem

**Files:**
- Modify: `src/lib/triagem.ts` (interface `TriagemResult`, `responseSchema`, guia de saída, normalização)

- [ ] **Step 1: Campo novo na interface**

Em `TriagemResult`, adicionar:

```ts
  /**
   * Horário que o paciente ACEITOU, quando houver. Preenchido só no turno em que
   * ele confirma — é o que o código usa pra reservar o slot (UNIQUE no Postgres).
   */
  horarioEscolhido: { data: string; hora: string; psicologa: string } | null;
```

- [ ] **Step 2: Campo no schema do Gemini**

Em `responseSchema.properties`, junto de `pronto`/`enviarForm`:

```ts
    horarioEscolhido: {
      type: Type.OBJECT,
      nullable: true,
      properties: {
        data: { type: Type.STRING, description: 'dd/mm/aaaa' },
        hora: { type: Type.STRING, description: 'HH:MM' },
        psicologa: { type: Type.STRING },
      },
      required: ['data', 'hora', 'psicologa'],
    },
```

E incluir `'horarioEscolhido'` em `required` e em `propertyOrdering`.

- [ ] **Step 3: Instrução no guia de saída**

Em `src/lib/triagem.ts:36`, depois da linha do `enviarForm`, acrescentar:

```
- "horarioEscolhido": preencha {data, hora, psicologa} SÓ no turno em que o paciente aceitar um horário concreto da agenda (data em dd/mm/aaaa, hora em HH:MM, nome da psicóloga como está no bloco [AGENDA DA CLÍNICA]). Nos outros turnos: null.
```

- [ ] **Step 4: Normalizar na saída**

Onde hoje há `enviarForm: o.enviarForm === true` (`src/lib/triagem.ts:271`), adicionar:

```ts
    horarioEscolhido:
      o.horarioEscolhido && o.horarioEscolhido.data && o.horarioEscolhido.hora && o.horarioEscolhido.psicologa
        ? {
            data: String(o.horarioEscolhido.data).trim(),
            hora: String(o.horarioEscolhido.hora).trim(),
            psicologa: String(o.horarioEscolhido.psicologa).trim(),
          }
        : null,
```

E no fallback de erro (`src/lib/triagem.ts:330`), acrescentar `horarioEscolhido: null` ao objeto retornado.

- [ ] **Step 5: Compilar**

Run: `npx tsc --noEmit`
Expected: sem erros (o `computeReply` repassa o campo; se acusar, adicione `horarioEscolhido` ao retorno dele).

- [ ] **Step 6: Commit**

```bash
git add src/lib/triagem.ts src/lib/conversation.ts
git commit -m "feat: triagem devolve o horario aceito pelo paciente"
```

---

### Task 9: Claim atômico no handoff

**Files:**
- Create: `src/lib/agendamento.ts`
- Test: `scripts/test-agendamento-core.ts`
- Modify: `src/app/api/whatsapp/webhook/route.ts`

- [ ] **Step 1: Teste da função pura de conversão de data**

Criar `scripts/test-agendamento-core.ts`:

```ts
import assert from 'node:assert';
import { dataBRparaISO, mensagemDeConflito } from '../src/lib/agendamento';

assert.equal(dataBRparaISO('30/07/2026'), '2026-07-30');
assert.equal(dataBRparaISO('5/8/2026'), '2026-08-05');
assert.equal(dataBRparaISO('2026-07-30'), '2026-07-30'); // já ISO, passa direto
assert.equal(dataBRparaISO('quinta'), null);
assert.equal(dataBRparaISO(''), null);

const m = mensagemDeConflito('quinta-feira às 18h');
assert.ok(/acabou de ser preenchido/i.test(m), 'explica o que houve');
assert.ok(/cr[ée]dito/i.test(m), 'garante o crédito do pagamento');
assert.ok(/\?$/.test(m.trim()), 'termina puxando a próxima etapa');

console.log('test-agendamento-core: todos os asserts passaram ✔');
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx tsx scripts/test-agendamento-core.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar**

Criar `src/lib/agendamento.ts`:

```ts
// Reserva de horário: o UNIQUE (data, hora, psicologa) do Postgres é quem decide
// quem ficou com o slot quando dois pacientes pagam ao mesmo tempo.
import { query } from './db';

/** "30/07/2026" -> "2026-07-30". Aceita ISO direto. null se não parsear. */
export function dataBRparaISO(s: string): string | null {
  const t = (s ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

/** Mensagem determinística de horário perdido — nunca redigida pelo modelo. */
export function mensagemDeConflito(quando: string): string {
  return (
    `Preciso te avisar uma coisa: o horário de ${quando} acabou de ser preenchido por outro paciente. ` +
    'Seu pagamento fica como crédito garantido e eu já te encaixo em outro horário. ' +
    'Quais dias e períodos funcionam pra você?'
  );
}

export type ResultadoReserva = 'reservado' | 'conflito' | 'indisponivel';

/**
 * Tenta reservar o slot. 'reservado' = ficou com este paciente; 'conflito' = já
 * era de outro; 'indisponivel' = dado incompleto ou erro de banco (fail-open —
 * o caller segue com o fechamento e a equipe confere).
 */
export async function reservarSlot(input: {
  data: string;
  hora: string;
  psicologa: string;
  waId: string;
  paciente?: string | null;
  modalidade?: string | null;
}): Promise<ResultadoReserva> {
  const iso = dataBRparaISO(input.data);
  if (!iso || !input.hora || !input.psicologa) return 'indisponivel';
  try {
    const res = await query(
      `INSERT INTO agendamentos (data, hora, psicologa, wa_id, paciente, modalidade)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (data, hora, psicologa) DO NOTHING
       RETURNING id`,
      [iso, input.hora.trim(), input.psicologa.trim(), input.waId, input.paciente ?? null, input.modalidade ?? null],
    );
    return res.rowCount === 1 ? 'reservado' : 'conflito';
  } catch (e) {
    console.error('[agendamento] reservarSlot falhou — seguindo sem trava', e);
    return 'indisponivel';
  }
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx tsx scripts/test-agendamento-core.ts`
Expected: `test-agendamento-core: todos os asserts passaram ✔`

- [ ] **Step 5: Plugar no webhook**

Em `src/app/api/whatsapp/webhook/route.ts`, logo depois do backstop de comprovante e ANTES do envio das bolhas:

```ts
      // Trava de dupla marcação: no turno do handoff, o slot é reservado
      // atomicamente. Perdeu a corrida → não fecha; avisa e reoferece.
      if (turno.enviarForm && turno.horarioEscolhido) {
        const r = await reservarSlot({
          ...turno.horarioEscolhido,
          waId: from,
          paciente: turno.lead.nome,
          modalidade: turno.lead.observacoes,
        });
        if (r === 'conflito') {
          const quando = `${turno.horarioEscolhido.data} às ${turno.horarioEscolhido.hora}`;
          await sendText(from, mensagemDeConflito(quando));
          await notifyTeam(from, nome, { ...turno, enviarForm: false }, comprovante);
          console.warn(`[agendamento] conflito de slot em ${quando} (${from}) — handoff abortado.`);
          return; // conversa segue ativa pra reofertar
        }
      }
```

E adicionar ao import do topo:

```ts
import { reservarSlot, mensagemDeConflito } from '@/lib/agendamento';
```

- [ ] **Step 6: Teste de claim duplo (banco real)**

Run (com `DATABASE_PUBLIC_URL` no ambiente):
```bash
npx tsx --env-file=.env.local -e "import('./src/lib/agendamento').then(async m => { const a = await m.reservarSlot({data:'01/01/2027',hora:'10:00',psicologa:'Teste',waId:'1'}); const b = await m.reservarSlot({data:'01/01/2027',hora:'10:00',psicologa:'Teste',waId:'2'}); console.log(a, b); })"
```
Expected: `reservado conflito`. Depois limpar: `DELETE FROM agendamentos WHERE psicologa = 'Teste';`

- [ ] **Step 7: Commit**

```bash
git add src/lib/agendamento.ts scripts/test-agendamento-core.ts src/app/api/whatsapp/webhook/route.ts
git commit -m "feat: claim atomico do horario no handoff (anti dupla marcacao)"
```

---

### Task 10: Slots reservados saem da oferta

**Files:**
- Modify: `src/lib/sheets.ts` (`agendaContexto`), `src/lib/agenda-core.ts` (`resumoDisponibilidade`)

- [ ] **Step 1: Carregar as reservas do banco**

Em `src/lib/sheets.ts`, dentro de `agendaContexto()`, antes de montar o resumo:

```ts
    // Reservas feitas pela própria Camila (a planilha só tem o que a Bruna lança).
    let reservas: { data: string; hora: string; psicologa: string }[] = [];
    try {
      const { rows } = await query<{ data: Date; hora: string; psicologa: string }>(
        `SELECT data, hora, psicologa FROM agendamentos WHERE data >= current_date ORDER BY data, hora LIMIT 50`,
      );
      reservas = rows.map((r) => ({
        data: new Date(r.data).toLocaleDateString('pt-BR'),
        hora: r.hora,
        psicologa: r.psicologa,
      }));
    } catch (e) {
      console.error('[sheets] não consegui ler agendamentos — resumo só com a planilha', e);
    }
    return resumoDisponibilidade(data, { hoje: agoraClinica(), reservas });
```

E importar `query` de `./db`.

- [ ] **Step 2: Aceitar `reservas` no resumo**

Em `src/lib/agenda-core.ts`, adicionar a opção:

```ts
export interface ResumoOpts {
  /** data de referência pra descartar reservas passadas (default: agora). Injetável nos testes. */
  hoje?: Date;
  /** reservas feitas pela Camila (Postgres), somadas às da aba "Agenda". */
  reservas?: { data: string; hora: string; psicologa: string }[];
}
```

E, ao montar `ocupados`, concatenar as reservas do banco antes do `.slice(0, 12)`:

```ts
  const doBanco = (opts.reservas ?? []).map((r) => ({
    data: r.data,
    hora: r.hora,
    psicologa: r.psicologa,
    modalidade: '',
    status: 'Confirmada',
  }));
```

tratando-as no mesmo `map` que gera as linhas de "Já reservado".

- [ ] **Step 3: Assert no teste**

Adicionar em `scripts/test-agenda.ts`:

```ts
const comReserva = resumoDisponibilidade(DADOS, {
  hoje: new Date(2026, 6, 27),
  reservas: [{ data: '29/07/2026', hora: '14:00', psicologa: 'Emanuelle Felix' }],
});
assert.ok(/29\/07\/2026 14:00 Emanuelle Felix/.test(comReserva), 'reserva do banco entra no bloco');
```

Run: `npx tsx scripts/test-agenda.ts`
Expected: passa.

- [ ] **Step 4: Commit**

```bash
git add src/lib/sheets.ts src/lib/agenda-core.ts scripts/test-agenda.ts
git commit -m "feat: horarios ja reservados no banco saem da oferta"
```

---

### Task 11: Validação final e deploy da Parte B

- [ ] **Step 1: Suíte inteira**

Run:
```bash
npx tsx scripts/test-agenda.ts && npx tsx scripts/test-agendamento-core.ts && npx tsx scripts/test-fechamento.ts && npx tsx scripts/test-retomada.ts && npx tsx scripts/test-split.ts && npx tsx scripts/test-contato.ts && npx tsx scripts/test-conducao.ts && npx tsx scripts/test-anti-repeat.ts && npx tsx scripts/test-parse-modelo.ts && npx tsx scripts/test-comprovante-core.ts && npx tsx scripts/test-followup.ts
```
Expected: todas verdes.

- [ ] **Step 2: Harness e simulação**

Run: `npx tsx --env-file=.env.local scripts/test-triagem.ts`
Run: `npx tsx --env-file=.env.local scripts/sim-conversa.ts passivo`
Expected: patamar mantido; a Camila propõe horário que existe na fixture e o funil fecha.

- [ ] **Step 3: Agenda real**

Run: `npx tsx --env-file=.env.local scripts/test-sheets-live.ts`
Expected: bloco com as 4 psicólogas reais, horários concretos, sem 400.

- [ ] **Step 4: Build e deploy**

```bash
npm run build
gh auth switch --user vertechsolutions && gh auth setup-git && git push origin master
curl -s https://clinica-psi-crm-production.up.railway.app/api/health
```

- [ ] **Step 5: Documentar**

Atualizar `CONTEXTO-CAZULE.md` (seção Leva 9: o que era o 400, o formato novo, a trava) e escrever a
mensagem pra Bruna avisando que a agenda voltou e o que ela precisa manter na planilha.

```bash
git add CONTEXTO-CAZULE.md mensagem-bruna-agenda.md docs/superpowers
git commit -m "docs: Leva 9 — agenda real e trava anti-conflito"
```

---

## Fora de escopo (backlog)

- Escrita automática na aba "Agenda" (exige SA como Editor).
- Cancelamento devolvendo o slot pra grade (a Bruna atualiza a planilha na mão hoje).
- Horizonte de 2 semanas com slots datados: a grade semanal + "próximo dia útil" já resolvem.
