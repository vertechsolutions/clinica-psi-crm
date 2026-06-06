import { runTriagem, type TriagemInput } from '@/lib/triagem';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  try {
    const { system, messages } = (await req.json()) as TriagemInput;
    const result = await runTriagem({ system, messages });
    return Response.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'erro desconhecido';
    const friendly = /GEMINI_API_KEY/i.test(msg)
      ? msg
      : /503|UNAVAILABLE|overloaded/i.test(msg)
        ? 'A assistente esta com muita demanda agora. Tenta de novo em alguns segundos.'
        : /429|RESOURCE_EXHAUSTED|quota/i.test(msg)
          ? 'Limite do plano gratis do Gemini atingido. Espera um pouco e tenta de novo.'
          : msg;
    return Response.json({ error: friendly }, { status: 500 });
  }
}
