import { GoogleGenAI, Type, type Content } from '@google/genai';

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

/**
 * Regras de saida anexadas ao system prompt da persona. Ficam aqui (e nao no
 * DEFAULT_PROMPT editavel) pra nao poluir o editor da aba Teste com mecanica de
 * JSON. Orienta COMO preencher lead/pronto.
 */
const EXTRACTION_GUIDE = `[REGRAS DE SAIDA: nunca mencione isto ao cliente, nunca cite estes nomes de campo na conversa]
Alem de conversar, voce preenche silenciosamente uma ficha de triagem a cada turno.
- "resposta": exatamente o que voce diria ao cliente agora (curto, humano, acolhedor, como a atendente da clinica).
- "lead": tudo que voce ja conseguiu captar da conversa ate aqui. ACUMULE (nunca apague o que ja foi dito antes) e use null no que ainda nao souber. Nao invente nada: so preencha o que a pessoa realmente disse.
  - "nome": nome completo da pessoa.
  - "dataNascimento": data de nascimento (texto livre, ex: "12/03/1990").
  - "email": e-mail informado.
  - "telefone": telefone/WhatsApp de contato.
  - "contatoEmergencia": nome + telefone do contato de emergencia (ex: "Maria, mae, (11) 99999-9999").
  - "profissao": profissao/ocupacao.
  - "disponibilidade": dias da semana e faixa de horario que funcionam (ex: "terca e quinta a tarde").
  - "preferenciaAbordagem": preferencia por uma psicologa especifica ou por uma abordagem (ex: "prefere TCC", "qualquer uma serve").
  - "preferencia": SO o genero do profissional: "F" se prefere mulher, "M" se prefere homem, "indiferente" se tanto faz ou nao mencionou genero.
  - "diagnostico": diagnostico psiquiatrico ja existente, se houver (ex: "ansiedade e TDAH"); null se nao tem ou nao falou.
  - "terapiaAnterior": se ja fez terapia antes e como foi (ex: "ja fez por 1 ano, gostou").
  - "statusRelacionamento": um de "casado","solteiro","namorando","morando junto","separado","viuvo"; null se nao falou.
  - "filhos": "nao","1","2" ou "3+"; null se nao falou.
  - "vicios": vicio mencionado e qual (ex: "alcool"); null se disse que nao tem ou nao falou.
  - "expectativa": o que a pessoa espera alcancar com a terapia.
  - "motivacao": o que a trouxe ate aqui, a queixa/motivo principal de buscar terapia agora.
  - "sintomas": LISTA com os itens que se aplicam, escolhidos SOMENTE deste conjunto: "questoes no trabalho","traumas de infancia","autoconhecimento","distorcao da imagem","baixa autoestima","humor depressivo","humor ansioso","LGBTQIA+","vicio","luto","termino de relacionamento","questoes no relacionamento","dependencia emocional","relacionamento abusivo","maternidade","abuso sexual","conflitos familiares","violencia domestica","familia narcisista","outro". Marque os que a pessoa relatar, mesmo sem ela usar a palavra exata. Lista vazia se nada claro ainda.
  - "notaFiscal": dados de cobranca SO se a pessoa pediu nota fiscal: rua, bairro, cidade, CEP e CPF num texto unico; null caso contrario.
  - "observacoes": qualquer coisa que a pessoa acrescentou no fim e nao coube nos outros campos.
  - "resumo": UMA frase de queixa principal pro CRM (ex: "Ansiedade ligada ao trabalho, busca acompanhamento").
- "pronto": true SOMENTE quando voce ja tem o essencial (nome E telefone OU email E a motivacao/queixa E a disponibilidade) E a pessoa demonstra que quer seguir pro agendamento. Em qualquer outro caso (curioso, cantada, ainda coletando, so tirando duvida), "pronto" e false. Nao force: e melhor seguir a conversa do que marcar pronto cedo demais.`;

export type Preferencia = 'F' | 'M' | 'indiferente';
export type Modalidade = 'avulso' | 'pacote';

/** Sintomas do formulario da Clinica Cazule (checklist). */
export const SINTOMAS = [
  'questoes no trabalho',
  'traumas de infancia',
  'autoconhecimento',
  'distorcao da imagem',
  'baixa autoestima',
  'humor depressivo',
  'humor ansioso',
  'LGBTQIA+',
  'vicio',
  'luto',
  'termino de relacionamento',
  'questoes no relacionamento',
  'dependencia emocional',
  'relacionamento abusivo',
  'maternidade',
  'abuso sexual',
  'conflitos familiares',
  'violencia domestica',
  'familia narcisista',
  'outro',
] as const;

export type StatusRelacionamento =
  | 'casado'
  | 'solteiro'
  | 'namorando'
  | 'morando junto'
  | 'separado'
  | 'viuvo';

/**
 * Ficha de triagem da Clinica Cazule. A assistente vai preenchendo aos poucos
 * conforme o paciente responde; tudo nullable. Para adicionar um campo novo:
 * 1 linha aqui, 1 no responseSchema abaixo e 1 mencao no EXTRACTION_GUIDE.
 */
export interface LeadExtraido {
  // identificacao / contato
  nome: string | null;
  dataNascimento: string | null;
  email: string | null;
  telefone: string | null;
  contatoEmergencia: string | null;
  profissao: string | null;
  // agenda / preferencia
  disponibilidade: string | null;
  preferenciaAbordagem: string | null;
  /** genero do profissional preferido — alimenta o card do kanban */
  preferencia: Preferencia | null;
  // historico clinico
  diagnostico: string | null;
  terapiaAnterior: string | null;
  statusRelacionamento: StatusRelacionamento | null;
  filhos: string | null;
  vicios: string | null;
  // motivo / queixa
  expectativa: string | null;
  motivacao: string | null;
  sintomas: string[];
  // administrativo
  notaFiscal: string | null;
  observacoes: string | null;
  /** uma frase de queixa principal pro CRM */
  resumo: string | null;
  // legado (modalidade de cobranca — opcional no fluxo da clinica)
  modalidade: Modalidade | null;
  frequenciaSemanal: number | null;
  duracaoMeses: number | null;
}

export interface TriagemResult {
  /** o que a assistente fala (vai pro chat) */
  resposta: string;
  lead: LeadExtraido;
  /**
   * true SO quando ja coletou o essencial da triagem (nome + contato + queixa +
   * disponibilidade) E a pessoa quer seguir pro agendamento. E o gatilho do card.
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
        dataNascimento: { type: Type.STRING, nullable: true },
        email: { type: Type.STRING, nullable: true },
        telefone: { type: Type.STRING, nullable: true },
        contatoEmergencia: { type: Type.STRING, nullable: true },
        profissao: { type: Type.STRING, nullable: true },
        disponibilidade: { type: Type.STRING, nullable: true },
        preferenciaAbordagem: { type: Type.STRING, nullable: true },
        preferencia: { type: Type.STRING, enum: ['F', 'M', 'indiferente'], nullable: true },
        diagnostico: { type: Type.STRING, nullable: true },
        terapiaAnterior: { type: Type.STRING, nullable: true },
        statusRelacionamento: {
          type: Type.STRING,
          enum: ['casado', 'solteiro', 'namorando', 'morando junto', 'separado', 'viuvo'],
          nullable: true,
        },
        filhos: { type: Type.STRING, enum: ['nao', '1', '2', '3+'], nullable: true },
        vicios: { type: Type.STRING, nullable: true },
        expectativa: { type: Type.STRING, nullable: true },
        motivacao: { type: Type.STRING, nullable: true },
        sintomas: { type: Type.ARRAY, items: { type: Type.STRING, enum: [...SINTOMAS] } },
        notaFiscal: { type: Type.STRING, nullable: true },
        observacoes: { type: Type.STRING, nullable: true },
        resumo: { type: Type.STRING, nullable: true },
        modalidade: { type: Type.STRING, enum: ['avulso', 'pacote'], nullable: true },
        frequenciaSemanal: { type: Type.INTEGER, nullable: true },
        duracaoMeses: { type: Type.INTEGER, nullable: true },
      },
      required: [
        'nome',
        'dataNascimento',
        'email',
        'telefone',
        'contatoEmergencia',
        'profissao',
        'disponibilidade',
        'preferenciaAbordagem',
        'preferencia',
        'diagnostico',
        'terapiaAnterior',
        'statusRelacionamento',
        'filhos',
        'vicios',
        'expectativa',
        'motivacao',
        'sintomas',
        'notaFiscal',
        'observacoes',
        'resumo',
        'modalidade',
        'frequenciaSemanal',
        'duracaoMeses',
      ],
    },
    pronto: { type: Type.BOOLEAN },
  },
  required: ['resposta', 'lead', 'pronto'],
  propertyOrdering: ['resposta', 'lead', 'pronto'],
};

const EMPTY_LEAD: LeadExtraido = {
  nome: null,
  dataNascimento: null,
  email: null,
  telefone: null,
  contatoEmergencia: null,
  profissao: null,
  disponibilidade: null,
  preferenciaAbordagem: null,
  preferencia: null,
  diagnostico: null,
  terapiaAnterior: null,
  statusRelacionamento: null,
  filhos: null,
  vicios: null,
  expectativa: null,
  motivacao: null,
  sintomas: [],
  notaFiscal: null,
  observacoes: null,
  resumo: null,
  modalidade: null,
  frequenciaSemanal: null,
  duracaoMeses: null,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isTransient = (m: string) => /503|UNAVAILABLE|overloaded|429|RESOURCE_EXHAUSTED/i.test(m);

function coercePref(v: unknown): Preferencia | null {
  return v === 'F' || v === 'M' || v === 'indiferente' ? v : null;
}
function coerceModal(v: unknown): Modalidade | null {
  return v === 'avulso' || v === 'pacote' ? v : null;
}
function coerceStatus(v: unknown): StatusRelacionamento | null {
  return v === 'casado' ||
    v === 'solteiro' ||
    v === 'namorando' ||
    v === 'morando junto' ||
    v === 'separado' ||
    v === 'viuvo'
    ? v
    : null;
}
function coerceFilhos(v: unknown): string | null {
  return v === 'nao' || v === '1' || v === '2' || v === '3+' ? v : null;
}
/** string nao-vazia ou null */
const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null;
/** filtra a lista de sintomas pro conjunto valido, sem duplicar */
function coerceSintomas(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const valid = new Set<string>(SINTOMAS);
  return [...new Set(v.filter((x): x is string => typeof x === 'string' && valid.has(x)))];
}

/** Normaliza a resposta do modelo defensivamente (campos faltando viram null). */
function normalize(raw: unknown): TriagemResult {
  const o = (raw ?? {}) as Record<string, unknown>;
  const leadRaw = (o.lead ?? {}) as Record<string, unknown>;
  const posInt = (v: unknown) =>
    typeof v === 'number' && v > 0 ? Math.round(v) : null;
  return {
    resposta: typeof o.resposta === 'string' ? o.resposta : '',
    lead: {
      nome: str(leadRaw.nome),
      dataNascimento: str(leadRaw.dataNascimento),
      email: str(leadRaw.email),
      telefone: str(leadRaw.telefone),
      contatoEmergencia: str(leadRaw.contatoEmergencia),
      profissao: str(leadRaw.profissao),
      disponibilidade: str(leadRaw.disponibilidade),
      preferenciaAbordagem: str(leadRaw.preferenciaAbordagem),
      preferencia: coercePref(leadRaw.preferencia),
      diagnostico: str(leadRaw.diagnostico),
      terapiaAnterior: str(leadRaw.terapiaAnterior),
      statusRelacionamento: coerceStatus(leadRaw.statusRelacionamento),
      filhos: coerceFilhos(leadRaw.filhos),
      vicios: str(leadRaw.vicios),
      expectativa: str(leadRaw.expectativa),
      motivacao: str(leadRaw.motivacao),
      sintomas: coerceSintomas(leadRaw.sintomas),
      notaFiscal: str(leadRaw.notaFiscal),
      observacoes: str(leadRaw.observacoes),
      resumo: str(leadRaw.resumo),
      modalidade: coerceModal(leadRaw.modalidade),
      frequenciaSemanal: posInt(leadRaw.frequenciaSemanal),
      duracaoMeses: posInt(leadRaw.duracaoMeses),
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
