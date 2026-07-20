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
        nomeDestinatario:
          typeof o.nomeDestinatario === 'string' && o.nomeDestinatario.trim() ? o.nomeDestinatario.trim() : null,
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
