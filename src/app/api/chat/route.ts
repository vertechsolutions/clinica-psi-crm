import Anthropic from '@anthropic-ai/sdk';

export const runtime = 'nodejs';

const MODEL = process.env.ASSISTANT_MODEL || 'claude-opus-4-8';

interface ChatBody {
  system: string;
  messages: Anthropic.MessageParam[];
}

export async function POST(req: Request) {
  try {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
      return Response.json(
        { error: 'ANTHROPIC_API_KEY não configurada. Defina em .env.local (dev) ou no Vercel (prod).' },
        { status: 500 },
      );
    }

    const { system, messages } = (await req.json()) as ChatBody;
    const client = new Anthropic({ apiKey: key });

    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      thinking: { type: 'adaptive' },
      system,
      messages,
    });

    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    return Response.json({ text });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'erro desconhecido';
    return Response.json({ error: msg }, { status: 500 });
  }
}
