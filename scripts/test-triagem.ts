/**
 * Harness de calibracao da triagem.
 * Roda cenarios de conversa contra runTriagem() (mesma logica da /api/chat) e
 * avalia se a assistente: filtra curioso/cantada, extrai nome+preferencia+
 * modalidade(+freq), nao crava preco, e so marca `pronto` na hora certa.
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
// vazamento de preco: "R$ 150", "150 reais", "custa 200", "200 conto"
const vazaPreco = (s: string) => /r\$\s?\d|\d{2,}\s*(reais|conto)|custa\s+\d{2,}/i.test(s);

const cenarios: Cenario[] = [
  {
    nome: 'curioso (so olhando)',
    falas: ['oi', 'to so dando uma olhada como funciona', 'ah entendi, depois eu volto'],
    checar: (t) => {
      const semPronto = !algumPronto(t);
      const semPreco = !vazaPreco(todasRespostas(t));
      return {
        ok: semPronto && semPreco,
        nota: `pronto=${algumPronto(t)} (esperado false) | vazouPreco=${!semPreco}`,
      };
    },
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
    nome: 'interessada avulso mulher',
    falas: [
      'oi, queria marcar uma consulta',
      'meu nome e Mariana',
      'prefiro ser atendida por uma mulher',
      'queria so uma sessao pra experimentar',
      'pode ser, quero sim',
    ],
    checar: (t) => {
      const l = ultimo(t).lead;
      const ok =
        algumPronto(t) &&
        !!l.nome &&
        l.preferencia === 'F' &&
        l.modalidade === 'avulso';
      return {
        ok,
        nota: `pronto=${algumPronto(t)} nome=${l.nome} pref=${l.preferencia} modal=${l.modalidade}`,
      };
    },
  },
  {
    nome: 'interessado pacote 2x homem 3 meses',
    falas: [
      'boa tarde, quero comecar terapia',
      'sou o Lucas',
      'prefiro um psicologo homem',
      'queria acompanhamento, um pacote mensal',
      'duas vezes por semana',
      'por uns 3 meses',
      'fechado, pode marcar',
    ],
    checar: (t) => {
      const l = ultimo(t).lead;
      const ok =
        algumPronto(t) &&
        !!l.nome &&
        l.preferencia === 'M' &&
        l.modalidade === 'pacote' &&
        (l.frequenciaSemanal ?? 0) >= 2 &&
        (l.duracaoMeses ?? 0) >= 1;
      return {
        ok,
        nota: `pronto=${algumPronto(t)} nome=${l.nome} pref=${l.preferencia} modal=${l.modalidade} freq=${l.frequenciaSemanal} meses=${l.duracaoMeses}`,
      };
    },
  },
  {
    nome: 'pergunta preco direto',
    falas: ['oi, quanto custa a sessao?'],
    checar: (t) => {
      const semPreco = !vazaPreco(todasRespostas(t));
      return {
        ok: semPreco && !algumPronto(t),
        nota: `vazouPreco=${!semPreco} | resposta="${ultimo(t).resposta.slice(0, 90)}"`,
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
  console.log(`\n[1m=== ${c.nome} ===[0m`);
  const history: { role: 'user' | 'assistant'; content: string }[] = [];
  const turnos: Turno[] = [];
  for (const fala of c.falas) {
    history.push({ role: 'user', content: fala });
    const res = await runTriagem({ system: DEFAULT_PROMPT, messages: history });
    history.push({ role: 'assistant', content: res.resposta });
    turnos.push({ fala, res });
    console.log(`  [36mpaciente:[0m ${fala}`);
    console.log(`  [35massist:[0m   ${res.resposta}`);
    console.log(
      `            [90mlead=${JSON.stringify(res.lead)} pronto=${res.pronto}[0m`,
    );
    await sleep(1200); // suaviza rate limit do free tier
  }
  const { ok, nota } = c.checar(turnos);
  console.log(ok ? `  [32mPASS[0m ${nota}` : `  [31mFAIL[0m ${nota}`);
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
      console.log(`  [31mERRO[0m ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`\n[1mResultado: ${pass}/${cenarios.length} cenarios passaram[0m`);
  process.exit(pass === cenarios.length ? 0 : 1);
}

main();
