import { GoogleGenAI } from '@google/genai';

/**
 * Transcrição de áudio via Gemini multimodal. Usado quando um paciente manda
 * áudio no WhatsApp — a atendente da clínica só atende por texto, então a gente
 * transcreve e trata como se fosse texto (com marcação "[áudio transcrito]:").
 *
 * Modelo separado do gemini de conversa (fica em GEMINI_TRANSCRIBE_MODEL) porque
 * flash-lite basta pra transcrição e é bem mais barato. Cai pro mesmo modelo da
 * triagem se a env não estiver setada.
 */
const MODEL = process.env.GEMINI_TRANSCRIBE_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash';

/** Limite duro: áudio maior que ~15MB não passa inline. WhatsApp voice fica bem abaixo. */
const MAX_BYTES = 15 * 1024 * 1024;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isTransient = (m: string) => /503|UNAVAILABLE|overloaded|429|RESOURCE_EXHAUSTED/i.test(m);

/**
 * Transcreve um áudio em PT-BR. Retorna null em falha (o chamador manda
 * mensagem pedindo texto). Não lança — best-effort.
 */
export async function transcribeAudio(
  bytes: Buffer,
  mimeType: string,
): Promise<string | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    console.error('[transcribe] GEMINI_API_KEY ausente — não dá pra transcrever.');
    return null;
  }
  if (bytes.length === 0) return null;
  if (bytes.length > MAX_BYTES) {
    console.warn(`[transcribe] áudio de ${bytes.length}B excede limite inline; ignorando.`);
    return null;
  }

  const ai = new GoogleGenAI({ apiKey: key });
  const base64 = bytes.toString('base64');

  const prompt =
    'Transcreva o áudio abaixo em português do Brasil, EXATAMENTE como falado, ' +
    'sem resumir e sem interpretar. Use acentuação e pontuação corretas. ' +
    'Se não houver fala clara, responda apenas: [inaudível]. ' +
    'Retorne SOMENTE a transcrição, sem prefixos, sem comentários.';

  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await ai.models.generateContent({
        model: MODEL,
        contents: [
          {
            role: 'user',
            parts: [
              { text: prompt },
              { inlineData: { mimeType, data: base64 } },
            ],
          },
        ],
        config: {
          thinkingConfig: { thinkingBudget: 0 },
        },
      });
      const text = (resp.text ?? '').trim();
      if (!text || /^\[inaudível\]$/i.test(text)) return null;
      return text;
    } catch (err) {
      lastErr = err;
      const m = err instanceof Error ? err.message : String(err);
      if (isTransient(m) && attempt < 2) {
        await sleep(700 * (attempt + 1));
        continue;
      }
      console.error('[transcribe] falha ao transcrever', err);
      return null;
    }
  }
  console.error('[transcribe] falha após retries', lastErr);
  return null;
}
