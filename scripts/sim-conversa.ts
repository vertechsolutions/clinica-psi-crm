/**
 * Simulador de conversa: o Gemini encena um PACIENTE (ou LEAD frio) e conversa,
 * turno a turno, com a Camila (runTriagem, mesma lógica do webhook). Serve pra
 * caçar regressões de UX/fluxo antes do deploy. Imprime a transcrição completa +
 * a ficha final + flags (pronto/enviarForm).
 *
 * Rodar:  npx tsx --env-file=.env.local scripts/sim-conversa.ts
 */
import { readFileSync } from 'node:fs';
try {
  for (const linha of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = linha.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) {
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  }
} catch {}

import { GoogleGenAI } from '@google/genai';
import { runTriagem } from '../src/lib/triagem';
import { DEFAULT_PROMPT } from '../src/lib/default-prompt';
import { splitReply } from '../src/lib/split-message';

interface Turno {
  paciente: string;
  camila: string;
  enviarForm: boolean;
}

interface Persona {
  nome: string;
  system: string;
  maxTurnos: number;
  encerra: (t: Turno[]) => boolean;
}

const PACIENTE_INDIVIDUAL: Persona = {
  nome: 'paciente-individual-ansiedade',
  system: `Você está simulando uma PACIENTE real no WhatsApp de uma clínica de psicologia.
Persona: Mariana, 29 anos, ansiosa por causa do trabalho, quer começar terapia INDIVIDUAL.
Regras: escreva como no WhatsApp, curto, uma mensagem por vez, em PT-BR. NÃO seja robótica.
Fluxo natural: cumprimente, pergunte o preço, demonstre interesse, aceite agendar, escolha um
horário que a atendente propuser, diga que vai pagar por Pix e, quando ela pedir o comprovante,
responda "[o paciente enviou uma imagem/anexo pelo WhatsApp — se o pagamento acabou de ser combinado, é provavelmente o comprovante]".
Responda SOMENTE com a próxima fala da paciente, sem aspas, sem narração.`,
  maxTurnos: 12,
  encerra: (t) => t.some((x) => x.enviarForm),
};

const LEAD_FRIO: Persona = {
  nome: 'lead-frio-curioso',
  system: `Você simula um LEAD curioso no WhatsApp de uma clínica de psicologia.
Persona: pergunta o preço, fica em dúvida, dá respostas evasivas e vai perdendo o interesse.
Nas últimas falas seja lacônico ("vou pensar", "depois te falo"). Escreva curto, PT-BR, uma
mensagem por vez. Responda SOMENTE com a próxima fala, sem aspas.`,
  maxTurnos: 5,
  encerra: () => false,
};

async function proximaFalaPaciente(
  ai: GoogleGenAI,
  persona: Persona,
  transcript: Turno[],
): Promise<string> {
  const historico = transcript
    .map((t) => `PACIENTE: ${t.paciente}\nATENDENTE: ${t.camila}`)
    .join('\n');
  const prompt = `${persona.system}\n\nConversa até agora:\n${historico || '(ainda não começou)'}\n\nPróxima fala da paciente:`;
  const resp = await ai.models.generateContent({
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: { thinkingConfig: { thinkingBudget: 0 } },
  });
  return (resp.text ?? '').trim().replace(/^["']|["']$/g, '');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function rodarPersona(ai: GoogleGenAI, persona: Persona): Promise<Turno[]> {
  console.log(`\n\x1b[1m=== SIM: ${persona.nome} ===\x1b[0m`);
  const history: { role: 'user' | 'assistant'; content: string }[] = [];
  const transcript: Turno[] = [];

  for (let i = 0; i < persona.maxTurnos; i++) {
    const fala = await proximaFalaPaciente(ai, persona, transcript);
    if (!fala) break;
    history.push({ role: 'user', content: fala });
    const res = await runTriagem({ system: DEFAULT_PROMPT, messages: history });
    history.push({ role: 'assistant', content: res.resposta });
    const bolhas = splitReply(res.resposta);
    transcript.push({ paciente: fala, camila: res.resposta, enviarForm: res.enviarForm });

    console.log(`\x1b[36mpaciente:\x1b[0m ${fala}`);
    bolhas.forEach((b, k) => console.log(`\x1b[35mcamila#${k + 1}:\x1b[0m ${b}`));
    if (res.enviarForm) console.log('  \x1b[33m>> enviarForm=true (handoff)\x1b[0m');
    if (persona.encerra(transcript)) break;
    await sleep(1200);
  }

  const respostasAssist = history.filter((h) => h.role === 'assistant').length;
  console.log(`\x1b[1mResumo ${persona.nome}: ${transcript.length} turnos, respostas do assistente=${respostasAssist}\x1b[0m`);
  return transcript;
}

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY ausente. Rode: npx tsx --env-file=.env.local scripts/sim-conversa.ts');
    process.exit(1);
  }
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  await rodarPersona(ai, PACIENTE_INDIVIDUAL);
  await rodarPersona(ai, LEAD_FRIO);
  console.log('\n\x1b[1mSimulação concluída. Revise as transcrições acima.\x1b[0m');
}

main();
