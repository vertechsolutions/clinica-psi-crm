import { GoogleGenAI, type Content } from '@google/genai';

export const runtime = 'nodejs';

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

interface ChatBody {
  system: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function POST(req: Request) {
  try {
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
      return Response.json(
        { error: 'GEMINI_API_KEY não configurada. Defina em .env.local (dev) ou no Vercel (prod).' },
        { status: 500 },
      );
    }

    const { system, messages } = (await req.json()) as ChatBody;
    const ai = new GoogleGenAI({ apiKey: key });

    const contents: Content[] = messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    // retry leve em sobrecarga/limite transitório (503/429)
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const resp = await ai.models.generateContent({
          model: MODEL,
          contents,
          config: { systemInstruction: system, thinkingConfig: { thinkingBudget: 0 } },
        });
        return Response.json({ text: resp.text ?? '' });
      } catch (err) {
        lastErr = err;
        const m = err instanceof Error ? err.message : String(err);
        if (/503|UNAVAILABLE|overloaded|429|RESOURCE_EXHAUSTED/i.test(m) && attempt < 2) {
          await sleep(700 * (attempt + 1));
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'erro desconhecido';
    const friendly = /503|UNAVAILABLE|overloaded/i.test(msg)
      ? 'A assistente está com muita demanda agora. Tenta de novo em alguns segundos.'
      : /429|RESOURCE_EXHAUSTED|quota/i.test(msg)
        ? 'Limite do plano grátis do Gemini atingido. Espera um pouco e tenta de novo.'
        : msg;
    return Response.json({ error: friendly }, { status: 500 });
  }
}
