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
import { resumoDisponibilidade } from '../src/lib/agenda-core';

/** Espelha o computeReply: substitui {FORM_URL} e {PIX_INFO} pelos valores reais. */
const SYSTEM = DEFAULT_PROMPT.replaceAll('{FORM_URL}', process.env.FORM_URL || '{FORM_URL}').replaceAll(
  '{PIX_INFO}',
  process.env.PIX_INFO || 'Chave Pix (celular): +55 27 98117-8233 — em nome de Bruna (Clínica Cazule)',
);

/**
 * Agenda fictícia gerada pela MESMA função do runtime (fidelidade máxima ao bloco
 * que a Camila vê em produção). Usada na persona individual pra exercitar o fluxo
 * completo: proposta de horário real → pagamento → comprovante → form.
 */
const AGENDA_FAKE = resumoDisponibilidade(
  {
    psicologas: [
      { nome: 'Bruna Ferreira', crp: 'CRP 16/1', abordagens: 'TCC, Humanista', individual: true, casal: true, infanto: true, prefGenero: 'F', obs: '' },
      { nome: 'Camila Rocha', crp: 'CRP 16/2', abordagens: 'TCC', individual: true, casal: true, infanto: false, prefGenero: 'F', obs: '' },
    ],
    grade: [
      { nome: 'Bruna Ferreira', janelas: { Segunda: '14:00-19:00', 'Terça': '14:00-19:00', Quinta: '14:00-19:00' } },
      { nome: 'Camila Rocha', janelas: { Segunda: '18:00-21:00', Quarta: '18:00-21:00', Sexta: '18:00-21:00' } },
    ],
    agenda: [
      { data: '20/07/2026', hora: '18:00', paciente: 'X', whatsapp: '', psicologa: 'Camila Rocha', modalidade: 'Individual', tipo: 'Avulsa', status: 'Confirmada', valor: '75', pagamento: 'Pix', nf: 'Não', obs: '' },
    ],
  },
  { hoje: new Date(2026, 6, 17) },
);
const SYSTEM_COM_AGENDA = `${SYSTEM}\n\n${AGENDA_FAKE}`;

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
  /** true = a Camila enxerga o bloco [AGENDA DA CLÍNICA] (fake) neste cenário. */
  comAgenda?: boolean;
}

const PACIENTE_INDIVIDUAL: Persona = {
  nome: 'paciente-individual-ansiedade (com agenda)',
  system: `Você está simulando uma PACIENTE real no WhatsApp de uma clínica de psicologia.
Persona: Mariana, 29 anos, ansiosa por causa do trabalho, quer começar terapia INDIVIDUAL.
Regras: escreva como no WhatsApp, curto, uma mensagem por vez, em PT-BR. NÃO seja robótica.
Fluxo natural: cumprimente, pergunte o preço, demonstre interesse, aceite agendar, escolha um
horário que a atendente propuser, diga que vai pagar por Pix e, quando ela pedir o comprovante,
responda "[o paciente enviou uma imagem/anexo pelo WhatsApp — se o pagamento acabou de ser combinado, é provavelmente o comprovante]".
Responda SOMENTE com a próxima fala da paciente, sem aspas, sem narração.`,
  maxTurnos: 12,
  encerra: (t) => t.some((x) => x.enviarForm),
  comAgenda: true,
};

const INSISTENTE_SEM_AGENDA: Persona = {
  nome: 'insistente-sem-agenda (anti-alucinação)',
  system: `Você simula um PACIENTE no WhatsApp de uma clínica de psicologia.
Persona: Diego, ansioso pra marcar logo. Diga que quer agendar terapia individual à noite,
e nos turnos seguintes COBRE resposta com variações de "e aí, conseguiu o horário?",
"alguma novidade?", "consegue me confirmar hoje?". Escreva curto, PT-BR, uma mensagem por vez.
Responda SOMENTE com a próxima fala, sem aspas.`,
  maxTurnos: 5,
  encerra: () => false,
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

const PACIENTE_PASSIVO: Persona = {
  nome: 'paciente-passivo (pipeline proativo)',
  system: `Você simula um PACIENTE PASSIVO no WhatsApp de uma clínica de psicologia.
Persona: Carlos, 35 anos, quer terapia individual por causa de estresse, mas é de POUCAS palavras:
NUNCA faz perguntas, NUNCA puxa assunto; responde curto ("oi", "sim", "ok", "pode ser").
Quando a atendente fizer uma pergunta específica, responda o mínimo: modalidade → "individual";
nome → "Carlos Souza"; motivo → "estresse no trabalho"; disponibilidade → "à noite";
dia/horário proposto → "pode ser"; avulsa ou pacote → "avulsa".
Se ela mandar os dados do Pix e pedir comprovante, responda EXATAMENTE:
"[o paciente enviou uma imagem/anexo pelo WhatsApp — se o pagamento acabou de ser combinado, é provavelmente o comprovante]".
Se ela não perguntar nada, responda só "ok". Responda SOMENTE a próxima fala, sem aspas.`,
  maxTurnos: 14,
  encerra: (t) => t.some((x) => x.enviarForm),
  comAgenda: true,
};

const PACIENTE_CASAL: Persona = {
  nome: 'paciente-casal-etapas-valores',
  system: `Você simula uma PACIENTE no WhatsApp de uma clínica de psicologia buscando TERAPIA DE CASAL.
Persona: Renata, 34 anos, casada, quer entender como funciona a terapia de casal antes de decidir.
Fluxo: cumprimente dizendo que é pra casal, pergunte quanto custa, depois pergunte como funcionam
as sessões (etapas), pergunte se pode um horário à noite, e encerre dizendo que vai conversar com o
marido e volta depois. Escreva curto, como no WhatsApp, PT-BR, uma mensagem por vez.
Responda SOMENTE com a próxima fala da paciente, sem aspas, sem narração.`,
  maxTurnos: 6,
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

  const system = persona.comAgenda ? SYSTEM_COM_AGENDA : SYSTEM;
  let ultimo: Awaited<ReturnType<typeof runTriagem>> | null = null;
  for (let i = 0; i < persona.maxTurnos; i++) {
    const fala = await proximaFalaPaciente(ai, persona, transcript);
    if (!fala) break;
    history.push({ role: 'user', content: fala });
    const res = await runTriagem({ system, messages: history });
    ultimo = res;
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
  console.log(`\x1b[1mResumo ${persona.nome}: ${transcript.length} turnos, respostas do assistente=${respostasAssist}, pronto=${ultimo?.pronto ?? false}\x1b[0m`);
  if (ultimo) console.log(`ficha final: ${JSON.stringify(ultimo.lead)}`);
  return transcript;
}

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY ausente. Rode: npx tsx --env-file=.env.local scripts/sim-conversa.ts');
    process.exit(1);
  }
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const personas = [PACIENTE_INDIVIDUAL, INSISTENTE_SEM_AGENDA, PACIENTE_CASAL, LEAD_FRIO, PACIENTE_PASSIVO];
  const filtro = process.argv[2]; // opcional: roda só personas cujo nome contém o filtro
  for (const p of personas) {
    if (!filtro || p.nome.includes(filtro)) await rodarPersona(ai, p);
  }
  console.log('\n\x1b[1mSimulação concluída. Revise as transcrições acima.\x1b[0m');
}

main();
