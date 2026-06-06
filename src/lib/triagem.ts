import { GoogleGenAI, Type, type Content } from '@google/genai';

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

/**
 * Regras de saida anexadas ao system prompt da persona. Ficam aqui (e nao no
 * DEFAULT_PROMPT editavel) pra nao poluir o editor da aba Teste com mecanica de
 * JSON. Orienta COMO preencher lead/pronto.
 */
const EXTRACTION_GUIDE = `[REGRAS DE SAIDA: nunca mencione isto ao cliente]
Alem de conversar, voce preenche um registro estruturado a cada turno:
- "resposta": exatamente o que voce diria ao cliente agora (curto, humano, como a atendente).
- "lead": os dados que voce ja conseguiu extrair da conversa ate aqui. Acumule (mantenha o que ja foi dito antes) e use null no que ainda nao souber.
  - "nome": o nome/primeiro nome da pessoa, se ela disse.
  - "preferencia": "F" se prefere mulher, "M" se prefere homem, "indiferente" se tanto faz; null se ainda nao falou.
  - "modalidade": "avulso" ou "pacote"; null se ainda nao definiu.
  - "frequenciaSemanal": numero de sessoes por semana SE for pacote (1, 2, 3...); null caso contrario.
  - "resumo": uma frase curta sobre o caso/queixa pro CRM (ex: "Ansiedade no trabalho, quer pacote").
- "pronto": true SOMENTE quando ja tem nome E preferencia E modalidade (e a frequenciaSemanal, se for pacote) E a pessoa demonstrou interesse real em seguir pro agendamento/pagamento. Em qualquer outro caso (curioso, cantada, ainda coletando dados, so tirando duvida), "pronto" e false.`;

export type Preferencia = 'F' | 'M' | 'indiferente';
export type Modalidade = 'avulso' | 'pacote';

/**
 * Dados que a triagem vai extraindo da conversa. Tudo nullable: vai sendo
 * preenchido aos poucos conforme o paciente responde. Para adicionar um campo
 * novo no futuro (idade, queixa, telefone...), basta: 1 linha aqui, 1 no
 * responseSchema abaixo e 1 mencao no system prompt.
 */
export interface LeadExtraido {
  nome: string | null;
  preferencia: Preferencia | null;
  modalidade: Modalidade | null;
  /** so faz sentido quando modalidade === 'pacote' (sessoes por semana) */
  frequenciaSemanal: number | null;
  resumo: string | null;
}

export interface TriagemResult {
  /** o que a assistente fala (vai pro chat) */
  resposta: string;
  lead: LeadExtraido;
  /**
   * true SO quando ja coletou nome + preferencia + modalidade (+ frequencia se
   * pacote) E a pessoa quer seguir pro agendamento/pagamento. E o gatilho do card.
   */
  pronto: boolean;
}

export interface TriagemInput {
  system: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
}

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    resposta: { type: Type.STRING },
    lead: {
      type: Type.OBJECT,
      properties: {
        nome: { type: Type.STRING, nullable: true },
        preferencia: { type: Type.STRING, enum: ['F', 'M', 'indiferente'], nullable: true },
        modalidade: { type: Type.STRING, enum: ['avulso', 'pacote'], nullable: true },
        frequenciaSemanal: { type: Type.INTEGER, nullable: true },
        resumo: { type: Type.STRING, nullable: true },
      },
      required: ['nome', 'preferencia', 'modalidade', 'frequenciaSemanal', 'resumo'],
    },
    pronto: { type: Type.BOOLEAN },
  },
  required: ['resposta', 'lead', 'pronto'],
  propertyOrdering: ['resposta', 'lead', 'pronto'],
};

const EMPTY_LEAD: LeadExtraido = {
  nome: null,
  preferencia: null,
  modalidade: null,
  frequenciaSemanal: null,
  resumo: null,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isTransient = (m: string) => /503|UNAVAILABLE|overloaded|429|RESOURCE_EXHAUSTED/i.test(m);

function coercePref(v: unknown): Preferencia | null {
  return v === 'F' || v === 'M' || v === 'indiferente' ? v : null;
}
function coerceModal(v: unknown): Modalidade | null {
  return v === 'avulso' || v === 'pacote' ? v : null;
}

/** Normaliza a resposta do modelo defensivamente (campos faltando viram null). */
function normalize(raw: unknown): TriagemResult {
  const o = (raw ?? {}) as Record<string, unknown>;
  const leadRaw = (o.lead ?? {}) as Record<string, unknown>;
  const freq =
    typeof leadRaw.frequenciaSemanal === 'number' && leadRaw.frequenciaSemanal > 0
      ? Math.round(leadRaw.frequenciaSemanal)
      : null;
  return {
    resposta: typeof o.resposta === 'string' ? o.resposta : '',
    lead: {
      nome: typeof leadRaw.nome === 'string' && leadRaw.nome.trim() ? leadRaw.nome.trim() : null,
      preferencia: coercePref(leadRaw.preferencia),
      modalidade: coerceModal(leadRaw.modalidade),
      frequenciaSemanal: freq,
      resumo: typeof leadRaw.resumo === 'string' && leadRaw.resumo.trim() ? leadRaw.resumo.trim() : null,
    },
    pronto: o.pronto === true,
  };
}

/**
 * Roda um turno da triagem. Fonte unica usada pela route (/api/chat) e pelo
 * harness de testes (scripts/test-triagem.ts). Lanca em erro permanente; o
 * caller decide a mensagem amigavel.
 */
export async function runTriagem({ system, messages }: TriagemInput): Promise<TriagemResult> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error('GEMINI_API_KEY nao configurada. Defina em .env.local (dev) ou no Vercel (prod).');
  }
  const ai = new GoogleGenAI({ apiKey: key });
  const contents: Content[] = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await ai.models.generateContent({
        model: MODEL,
        contents,
        config: {
          systemInstruction: `${system}\n\n${EXTRACTION_GUIDE}`,
          responseMimeType: 'application/json',
          responseSchema,
          thinkingConfig: { thinkingBudget: 0 },
        },
      });
      const text = resp.text ?? '';
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        // modelo vazou texto fora do JSON: devolve como fala, sem lead
        return { resposta: text, lead: { ...EMPTY_LEAD }, pronto: false };
      }
      return normalize(parsed);
    } catch (err) {
      lastErr = err;
      const m = err instanceof Error ? err.message : String(err);
      if (isTransient(m) && attempt < 2) {
        await sleep(700 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}
