// Trava determinística contra o bug de repetição verbatim (reportado pela Bruna
// em 19/07/2026): regra de prompt é probabilística e falhou em produção; esta
// camada de código garante que a resposta nunca sai igual à anterior.

import { runTriagem, type TriagemInput, type TriagemResult } from './triagem';

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
