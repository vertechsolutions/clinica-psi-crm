import { GoogleGenAI, type Content } from '@google/genai';

export const runtime = 'nodejs';

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

interface ChatBody {
  system: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
}

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

    const resp = await ai.models.generateContent({
      model: MODEL,
      contents,
      config: { systemInstruction: system, thinkingConfig: { thinkingBudget: 0 } },
    });

    return Response.json({ text: resp.text ?? '' });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'erro desconhecido';
    const friendly = /429|RESOURCE_EXHAUSTED|quota/i.test(msg)
      ? 'Limite do plano grátis do Gemini atingido. Espera um pouco e tenta de novo.'
      : msg;
    return Response.json({ error: friendly }, { status: 500 });
  }
}
