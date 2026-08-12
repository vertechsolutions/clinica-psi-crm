/**
 * Comparação de texto para os guards determinísticos. Funções puras, sem
 * dependência nenhuma.
 *
 * Moravam no `anti-repeat.ts` até 11/08/2026. Saíram de lá quando o
 * `conducao.terminaSemAvancar` passou a precisar comparar a pergunta final com
 * as dos turnos anteriores: o `anti-repeat` já importa o `conducao`, e importar
 * de volta fecharia um ciclo. O `anti-repeat` reexporta os dois nomes, então
 * nada que já os usava precisou mudar.
 */

/** Normaliza pra comparação: minúsculas, sem pontuação, espaços colapsados. */
export function normalizaComparacao(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.,!?;:…"'“”‘’()\[\]{}*_~\-—–/\\]/g, ' ')
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
