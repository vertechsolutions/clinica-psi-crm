// Trava determinística contra o bug de repetição verbatim (reportado pela Bruna
// em 19/07/2026): regra de prompt é probabilística e falhou em produção; esta
// camada de código garante que a resposta nunca sai igual à anterior.

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
