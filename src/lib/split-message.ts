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

/** conta frases aproximadas (mesma heurística de splitBySentence). */
function contarFrases(s: string): number {
  return (s.match(/[^.!?…]+[.!?…]+|\S[^.!?…]*$/g) ?? []).filter((f) => f.trim()).length;
}

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
  if (parts.length === 1 && parts[0].length > AUTO_SPLIT_MIN && contarFrases(parts[0]) >= 3) {
    const repartido = splitBySentence(parts[0], Math.ceil(parts[0].length / 2));
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
