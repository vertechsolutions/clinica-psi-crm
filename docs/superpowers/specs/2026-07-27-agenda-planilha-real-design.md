# Leva 9 — Agenda real: parser da planilha nova + trava anti-conflito (design)

**Data:** 27/07/2026
**Origem:** planilha reestruturada pela Bruna em 24/07 + respostas dela (texto e áudios `PTT-20260724-*`) + achado de produção.
**Precedência:** este plano roda DEPOIS da Leva 11 (fechamento + retomada), que já está escrita.

## Problema

`agendaContexto()` responde **Sheets API 400** em produção desde que a Bruna reestruturou a planilha.
Confirmado hoje com `scripts/test-sheets-live.ts`:

```
[sheets] agendaContexto falhou — seguindo sem agenda Error: Sheets API 400
```

Causa: `src/lib/sheets.ts:18` pede `batchGet` das abas fixas `['Psicólogas', 'Grade Semanal', 'Agenda']`.
A aba **"Grade Semanal" não existe mais** — um range inexistente derruba o batchGet inteiro (400), então
nem "Psicólogas" nem "Agenda" chegam.

Abas reais hoje (dump via API):

```
["Instruções","Psicólogas","Talita ","Gabriela Goulart","Emanuelle Felix","Mery Helen","Agenda"]
```

Consequência em produção: a Camila roda **sem o bloco `[AGENDA DA CLÍNICA]`**. A REGRA DURA do prompt
manda dizer "vou verificar com a equipe", mas é probabilística — no print de 27/07 ela agendou
"segunda-feira às 16h com a psicóloga **Bruna Ferreira**", profissional que **não existe** na clínica.
"Bruna Ferreira" está na planilha como resíduo dos dados de exemplo (célula A1 da aba "Mery Helen" e
várias linhas da aba "Agenda").

Segundo problema, ainda não visível porque a agenda não carrega: **dupla marcação**. A Camila só lê a
planilha (cache 60s), o "já reservado" é texto no prompt e o fechamento só marca `pausada=TRUE`. Dois
pacientes podem pagar o mesmo horário.

## O que a planilha tem hoje

**Aba "Psicólogas"** (cabeçalho + 5 linhas) — formato antigo, ainda compatível com `parsePsicologas`:

| Psicóloga | CRP | Abordagens | Individual | Casal | Infanto 13+ | Pref. (F/M) |
|---|---|---|---|---|---|---|
| Talita de Souza | CRP 12/28011 | Gestalt Terapia | Sim | Não | Sim | F |
| Mery Helen | CRP 16/8515 | TCC | Sim | Não | Não | F/M |
| Joseane monteiro | CRP 12/16461 | Humanista | Sim | Não | Não | F/M |
| Gabriela Goulart | CRP 05/83143 | Psicanálise | Sim | sim | Não | F/M |
| Emanuelle Felix | CRP 16/11151 | Psicologia Analítica/Junguiana | não | Sim | Não | F/M |

**Uma aba por psicóloga** — colunas = dias da semana, cada célula = um horário de **início**:

```
["Psicóloga","Segunda","Terça","Quarta","Quinta","Sexta","Sábado"]
["","10:00","","10:00","13:00","11:15"]
["","11:00","","11;00","14:00","13:00"]
```

Sujeira real a tolerar:
- typos de digitação: `11;00`, `13;00`, `14;00`, `15;00`, `08:0`
- horários quebrados legítimos (sessão de 45 min): `08:45`, `11:15`, `13:45`, `15:15`, `19:45`
- título de aba com espaço sobrando: `"Talita "`
- cabeçalho da aba "Mery Helen" com `Bruna Ferreira` na célula A1 (resíduo do modelo)
- célula solta com `0` na aba da Emanuelle; `-` como "não atende"
- **Joseane não tem aba** — ela disse no áudio que ia sair da agenda ("já está com todos os horários preenchidos")

**Aba "Agenda"**: só dados de exemplo, com 5 psicólogas fictícias (Bruna Ferreira, Débora Lima, Fernanda
Alves, Camila Rocha, Patrícia Nunes).

## Regras que a Bruna definiu (áudios de 24/07)

- **Formato**: aba por psicóloga, um horário por linha em cada coluna de dia. Ela mantém e atualiza toda semana.
- **Talita não atende homens** (coluna Pref. = `F`).
- **Emanuelle só atende casal** (Individual = `não`).
- **Agendamentos por fora não entram na aba Agenda**: as psicólogas seguem marcando nas agendas delas; a
  Bruna revisa o sistema toda semana e tira da grade os horários que ficaram ocupados. Ou seja: a grade
  por psicóloga **é** a fonte da verdade dos horários livres.
- **Antecedência**: agendar sempre a partir do **próximo dia útil**.
- Pacote mensal: em tese o mesmo horário toda semana, mas quem garante é ela atualizando a planilha.

## Solução

### Parte A — a agenda volta a funcionar (deployável sozinha)

1. **`sheets.ts` descobre as abas** em vez de assumir nomes fixos: `GET /spreadsheets/{id}?fields=sheets.properties.title`,
   depois um `batchGet` só com ranges que existem — "Psicólogas", "Agenda" e as abas cujo título casa com
   uma psicóloga cadastrada (comparação normalizada: `trim`, minúsculas, sem acento; casa por nome
   completo ou pelo primeiro nome). Range inexistente nunca mais entra no batchGet.
2. **`agenda-core.ts` ganha `parseGradeDeAba(rows)`**: lê as colunas Segunda..Sábado e devolve a lista de
   horários de início por dia, com normalização tolerante — `;` vira `:`, `8:0`/`08:0` vira `08:00`,
   `8:00` vira `08:00`, descarta `-`, `0`, vazio e qualquer coisa que não seja hora válida (00:00–23:59).
   Ordena e remove duplicatas.
3. **`resumoDisponibilidade` passa a listar horários concretos** em vez de janelas, e a incluir a
   restrição de gênero quando a psicóloga só atende um (`Pref. = F` → "só pacientes mulheres"). Quem não
   tem aba de horários (Joseane hoje) não aparece — comportamento que já existe.
4. **Limpeza da planilha** (feita à mão, uma vez): apagar as linhas de exemplo da aba "Agenda", corrigir
   o A1 da aba "Mery Helen", corrigir os typos. É o que tira "Bruna Ferreira" do sistema de vez.

Só isso já mata a alucinação: com o bloco presente, a Camila propõe horário real de psicóloga real.

### Parte B — trava contra dupla marcação

5. **Tabela `agendamentos`** no Postgres com `UNIQUE (data, hora, psicologa)`.
6. **Campo `horarioEscolhido {data, hora, psicologa} | null`** no schema JSON da triagem (`triagem.ts`),
   preenchido quando a Camila fecha um horário; persiste no `lead`.
7. **Claim atômico no turno do handoff**: antes de enviar o fechamento, `INSERT ... ON CONFLICT DO NOTHING`.
   - Sucesso → segue o fechamento normal da Leva 11.
   - Conflito → **não** envia o fechamento: manda uma mensagem determinística ("esse horário acabou de ser
     preenchido; seu pagamento fica como crédito e eu já te ofereço outro"), alerta a equipe com tag de
     CONFLITO e mantém a conversa ativa pra reofertar.
8. **Slots ocupados saem da oferta**: o resumo passa a subtrair da grade os horários já em `agendamentos`
   (além da aba "Agenda").

### Fora de escopo

- **Escrita automática na aba "Agenda"** (a SA precisaria virar Editor). O alerta de handoff já entrega
  todos os dados pra Bruna lançar, e ela mesma disse que revisa a planilha semanalmente. Fica pra depois
  da Parte B estar estável.
- Expansão em slots datados com horizonte de 2 semanas: a grade semanal + a linha "Hoje é..." + a regra do
  próximo dia útil já bastam pro modelo propor certo, e custa muito menos prompt.

## Riscos

| risco | mitigação |
|---|---|
| Bloco de agenda fica grande demais e dilui o prompt | horários concretos de 4 psicólogas ≈ 1,2 KB — cabe; teste mede o tamanho |
| Aba nova da Bruna com nome que não casa com a "Psicólogas" | log explícito de aba ignorada + fallback: se nenhuma aba casar, a Camila roda sem agenda (comportamento seguro de hoje) |
| Bruna renomear/apagar aba de novo | descoberta dinâmica: qualquer conjunto de abas funciona, e range inexistente nunca é pedido |
| Claim atômico falha por erro de banco | fail-open com alerta: envia o fechamento e avisa a equipe pra conferir manualmente (perder venda é pior que dupla marcação, que é rara e contornável) |

## Validação

- `test-agenda` ganha fixtures **com a sujeira real** (`11;00`, `08:0`, `"Talita "`, `-`, `0`).
- `test-sheets-live` passa a imprimir o bloco montado a partir da planilha de verdade.
- Teste de claim duplo: dois `INSERT` concorrentes, o segundo devolve conflito.
- `test-triagem`: cenário "paciente pede sábado com psicóloga que não atende sábado" e cenário
  "paciente homem pede a Talita" (deve oferecer outra).
