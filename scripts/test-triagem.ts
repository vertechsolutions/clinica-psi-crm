/**
 * Harness de calibracao do raciocinio da assistente.
 * Roda cenarios de conversa contra runTriagem() (mesma logica da /api/chat e do
 * webhook do WhatsApp) e avalia se a assistente: filtra curioso/cantada, INFORMA
 * os valores quando perguntada, oferece as abordagens, acolhe, extrai a ficha e
 * so marca `pronto` na hora certa.
 *
 * Rodar:  npx tsx --env-file=.env.local scripts/test-triagem.ts
 */
import { readFileSync } from 'node:fs';

// carrega .env.local sem dependencia externa (a key e lida lazy dentro de runTriagem)
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

import { runTriagem, type TriagemResult } from '../src/lib/triagem';
import { DEFAULT_PROMPT } from '../src/lib/default-prompt';

type Turno = { fala: string; res: TriagemResult };

interface Cenario {
  nome: string;
  falas: string[];
  checar: (t: Turno[]) => { ok: boolean; nota: string };
}

const ultimo = (t: Turno[]) => t[t.length - 1].res;
const algumPronto = (t: Turno[]) => t.some((x) => x.res.pronto);
const todasRespostas = (t: Turno[]) => t.map((x) => x.res.resposta).join('\n');
// informou valor: "R$ 75", "75 reais", "280", "avulsa", "pacote"
const informaValor = (s: string) => /r\$\s?\d|\b(75|280)\b|avulsa|pacote/i.test(s);
const citaAbordagem = (s: string) => /tcc|cognitivo|psican|humanist/i.test(s);

const cenarios: Cenario[] = [
  {
    nome: 'curioso (so olhando)',
    falas: ['oi', 'to so dando uma olhada como funciona', 'ah entendi, depois eu volto'],
    checar: (t) => ({
      ok: !algumPronto(t),
      nota: `pronto=${algumPronto(t)} (esperado false)`,
    }),
  },
  {
    nome: 'cantada / pede foto',
    falas: ['oi linda', 'vc e casada? rs', 'manda uma foto sua ai'],
    checar: (t) => ({
      ok: !algumPronto(t),
      nota: `pronto=${algumPronto(t)} (esperado false) | ultimaResposta="${ultimo(t).resposta.slice(0, 80)}"`,
    }),
  },
  {
    nome: 'pergunta preco -> DEVE informar os valores',
    falas: ['oi, queria saber quanto custa a sessao'],
    checar: (t) => {
      const informou = informaValor(todasRespostas(t));
      return {
        ok: informou,
        nota: `informouValor=${informou} (esperado true) | resposta="${ultimo(t).resposta.slice(0, 120)}"`,
      };
    },
  },
  {
    nome: 'pergunta abordagem -> DEVE citar TCC/psicanalise/humanista',
    falas: ['oi, qual e a abordagem de voces?'],
    checar: (t) => {
      const citou = citaAbordagem(todasRespostas(t));
      return {
        ok: citou,
        nota: `citouAbordagem=${citou} (esperado true) | resposta="${ultimo(t).resposta.slice(0, 120)}"`,
      };
    },
  },
  {
    nome: 'interessada ansiedade no trabalho',
    falas: [
      'oi, queria comecar a fazer terapia',
      'meu nome e Mariana Souza',
      'ando muito ansiosa, principalmente por causa do trabalho, nao consigo desligar',
      'ja tenho diagnostico de ansiedade sim, tomo remedio',
      'nunca fiz terapia antes',
      'sou advogada',
      'queria me sentir mais tranquila e dormir melhor',
      'posso terca ou quinta a tarde',
      'meu email e mari.souza@email.com e meu telefone 11 98888-7777',
      'pode marcar sim, obrigada',
    ],
    checar: (t) => {
      const l = ultimo(t).lead;
      const sintomasOk =
        l.sintomas.includes('humor ansioso') || l.sintomas.includes('questoes no trabalho');
      const ok =
        algumPronto(t) &&
        !!l.nome &&
        (!!l.telefone || !!l.email) &&
        (!!l.motivacao || !!l.resumo) &&
        !!l.disponibilidade &&
        sintomasOk;
      return {
        ok,
        nota: `pronto=${algumPronto(t)} nome=${l.nome} tel=${l.telefone} email=${l.email} disp=${l.disponibilidade} sintomas=[${l.sintomas.join(', ')}] diag=${l.diagnostico}`,
      };
    },
  },
  {
    nome: 'luto, ja fez terapia, quer abordagem',
    falas: [
      'boa tarde, perdi minha mae faz dois meses e to muito mal',
      'sou o Lucas Pereira',
      'ja fiz terapia ha uns anos, foi bom, me ajudou bastante',
      'gostaria de uma psicologa, e se possivel TCC',
      'consigo nas segundas de manha',
      'meu whatsapp e 21 97777-6666',
      'em caso de emergencia pode falar com minha irma Ana, 21 95555-4444',
      'pode seguir, obrigado',
    ],
    checar: (t) => {
      const l = ultimo(t).lead;
      const ok =
        algumPronto(t) &&
        !!l.nome &&
        !!l.telefone &&
        l.sintomas.includes('luto') &&
        !!l.disponibilidade;
      return {
        ok,
        nota: `pronto=${algumPronto(t)} nome=${l.nome} tel=${l.telefone} emerg=${l.contatoEmergencia} terapiaAnt=${l.terapiaAnterior} abordagem=${l.preferenciaAbordagem} sintomas=[${l.sintomas.join(', ')}]`,
      };
    },
  },
  {
    nome: 'indeciso',
    falas: ['oi', 'queria entender como funciona a terapia online', 'deixa eu pensar e te aviso'],
    checar: (t) => ({
      ok: !algumPronto(t),
      nota: `pronto=${algumPronto(t)} (esperado false)`,
    }),
  },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function rodarCenario(c: Cenario): Promise<boolean> {
  console.log(`\n[1m=== ${c.nome} ===[0m`);
  const history: { role: 'user' | 'assistant'; content: string }[] = [];
  const turnos: Turno[] = [];
  for (const fala of c.falas) {
    history.push({ role: 'user', content: fala });
    const res = await runTriagem({ system: DEFAULT_PROMPT, messages: history });
    history.push({ role: 'assistant', content: res.resposta });
    turnos.push({ fala, res });
    console.log(`  [36mpaciente:[0m ${fala}`);
    console.log(`  [35massist:[0m   ${res.resposta}`);
    await sleep(1200); // suaviza rate limit do free tier
  }
  const { ok, nota } = c.checar(turnos);
  console.log(ok ? `  [32mPASS[0m ${nota}` : `  [31mFAIL[0m ${nota}`);
  return ok;
}

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY ausente. Rode com: npx tsx --env-file=.env.local scripts/test-triagem.ts');
    process.exit(1);
  }
  let pass = 0;
  for (const c of cenarios) {
    try {
      if (await rodarCenario(c)) pass++;
    } catch (e) {
      console.log(`  [31mERRO[0m ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`\n[1mResultado: ${pass}/${cenarios.length} cenarios passaram[0m`);
  process.exit(pass === cenarios.length ? 0 : 1);
}

main();
