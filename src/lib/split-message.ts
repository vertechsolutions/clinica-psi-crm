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
