/**
 * Quebra a resposta da Camila em 1–3 mensagens de WhatsApp ("bolhas"). O modelo
 * separa mensagens intencionais com uma linha em branco; respostas longas são
 * cortadas por frase. Mantém a UX de conversa (mensagens curtas, uma coisa por
 * vez) sem depender só da disciplina do modelo. Função pura — fácil de testar.
 */
export interface SplitOpts {
  /** tamanho máximo de cada bolha (chars). WhatsApp aguenta 4096; 350 mantém as bolhas curtas (backstop; o ideal é o modelo quebrar com linha em branco). */
  maxLen?: number;
  /** máximo de bolhas por turno. O excedente é juntado na última. */
  maxParts?: number;
}

const DEFAULT_MAX_LEN = 350;
const DEFAULT_MAX_PARTS = 3;
// Se o modelo mandou tudo num parágrafo só (sem linha em branco) e ficou uma
// bolha longa com várias frases, o código reparte em ~2 bolhas por frase — assim
// a UX de "2-3 balões" não depende do modelo lembrar de pular linha.
const AUTO_SPLIT_MIN = 180;

/**
 * As frases de um texto. Fonte ÚNICA da heurística: até 11/08/2026 a mesma
 * regex vivia duplicada no `contarFrases` e no `splitBySentence`, e duas cópias
 * de uma heurística um dia divergem.
 */
function frasesDe(s: string): string[] {
  return (s.match(/[^.!?…]+[.!?…]+|\S[^.!?…]*$/g) ?? []).map((f) => f.trim()).filter(Boolean);
}

/** conta frases aproximadas (mesma heurística de splitBySentence). */
function contarFrases(s: string): number {
  return frasesDe(s).length;
}

/** Comprimento da maior frase — o piso que impede o auto-split de picotar uma. */
function maiorFrase(s: string): number {
  return frasesDe(s).reduce((max, f) => Math.max(max, f.length), 0);
}

/** Quebra um parágrafo grande em pedaços <= maxLen, preferindo fim de frase. */
function splitBySentence(paragraph: string, maxLen: number): string[] {
  const sentences = frasesDe(paragraph);
  if (sentences.length === 0) sentences.push(paragraph);
  const out: string[] = [];
  let buf = '';
  for (const s of sentences) {
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
  // Normalização defensiva: o modelo às vezes cola frases ("atender.As sessões").
  // Insere espaço após pontuação seguida de maiúscula. Restrito a maiúsculas pra
  // não quebrar URLs (docs.google.com) nem decimais.
  const clean = (text ?? '').replace(/([.!?…])(?=[A-ZÀ-ÖØ-Þ])/g, '$1 ').trim();
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
  // Fallback (só se os parágrafos ficaram todos vazios): garante o invariante de
  // maxLen quebrando por frase em vez de devolver o texto cru.
  if (parts.length === 0) parts.push(...splitBySentence(clean, maxLen));

  // Auto-split: sobrou UMA bolha longa e multi-frase (o modelo não pulou linha) →
  // reparte por frase em ~2 bolhas equilibradas, garantindo os balões.
  //
  // O `maiorFrase` no piso é a correção do print de 11/08/2026 (uma bolha
  // terminou em "por volta de 10h15 da" e a seguinte começou em "manhã."). Só
  // com `ceil(len/2)`, qualquer frase maior que a metade do texto estourava o
  // maxLen e caía no hard-split do `splitBySentence`, que corta no ESPAÇO. Com o
  // piso, nenhuma frase individual excede o teto e o hard-split nunca dispara
  // por aqui — o equilíbrio das bolhas cede primeiro, que é a troca certa: uma
  // bolha a mais de texto é invisível, uma frase partida a cliente fotografou.
  if (parts.length === 1 && parts[0].length > AUTO_SPLIT_MIN && contarFrases(parts[0]) >= 3) {
    const teto = Math.max(Math.ceil(parts[0].length / 2), maiorFrase(parts[0]));
    const repartido = splitBySentence(parts[0], teto);
    if (repartido.length >= 2) {
      parts.length = 0;
      parts.push(...repartido);
    }
  }

  if (parts.length > maxParts) {
    const head = parts.slice(0, maxParts - 1);
    const tail = parts.slice(maxParts - 1).join('\n\n');
    return [...head, tail];
  }
  return parts;
}
