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

import { type TriagemResult } from '../src/lib/triagem';
import { runTriagemSemRepeticao, ehRepeticao } from '../src/lib/anti-repeat';
import { DEFAULT_PROMPT } from '../src/lib/default-prompt';
import { resumoDisponibilidade } from '../src/lib/agenda-core';
import { montarMarcadorComprovante, type AnaliseComprovante } from '../src/lib/comprovante-core';
import { splitReply } from '../src/lib/split-message';

// Análise de comprovante VÁLIDA (avulsa individual, chave da clínica) — os
// cenários derivam variações dela. Usa a MESMA função da produção pra montar
// o marcador: fixture nunca desvia do que o webhook injeta de verdade.
const ANALISE_OK: AnaliseComprovante = {
  ehComprovante: true,
  valor: 75,
  nomeDestinatario: 'Bruna Amorim',
  chaveDestino: '+55 27 98117-8233',
  instituicao: 'Nubank',
  dataHora: '20/07/2026 15:10',
};

// Agenda fake gerada pela função real (mesmo formato da produção): sem ela a
// REGRA DURA impede a Camila de confirmar horário/avançar ao pagamento, e os
// cenários de agendamento/Pix não fecham. Janelas cobrem os pedidos dos cenários
// (quarta à tarde = Fernanda; terça/quinta = Bruna).
const AGENDA_FAKE = resumoDisponibilidade(
  {
    psicologas: [
      { nome: 'Bruna Ferreira', crp: 'CRP 16/1', abordagens: 'TCC, Humanista', individual: true, casal: true, infanto: true, prefGenero: 'F', obs: '' },
      { nome: 'Fernanda Alves', crp: 'CRP 16/2', abordagens: 'TCC, Psicanálise', individual: true, casal: true, infanto: false, prefGenero: 'F', obs: '' },
    ],
    grade: [
      { nome: 'Bruna Ferreira', janelas: { Segunda: '14:00-19:00', 'Terça': '14:00-19:00', Quinta: '14:00-19:00' } },
      { nome: 'Fernanda Alves', janelas: { Quarta: '13:00-17:00', Sexta: '13:00-17:00' } },
    ],
    agenda: [],
  },
  { hoje: new Date(2026, 6, 17) },
);

// espelha o computeReply: injeta os dados do Pix (valor de teste fixo) + agenda
const SYSTEM =
  DEFAULT_PROMPT.replaceAll(
    '{PIX_INFO}',
    'Chave Pix (celular): +55 27 98117-8233 — em nome de Bruna (Clínica Cazule)',
  ) + `\n\n${AGENDA_FAKE}`;

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
      // segundas à TARDE: janela real da agenda fake (Bruna seg 14-19). Com "de
      // manhã" a Camila corretamente nega o horário (REGRA DE JANELA) e a conversa
      // trava sem slot viável — o cenário quer testar extração, não conflito de janela.
      'consigo nas segundas a tarde',
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
  {
    nome: 'audio transcrito -> trata como texto, informa valor, sem desviar',
    falas: ['[áudio transcrito]: oi tudo bem? queria saber quanto custa a sessao'],
    checar: (t) => {
      const todas = todasRespostas(t);
      const informou = informaValor(todas);
      // a IA NÃO pode pedir texto / dizer que não ouviu — o áudio já veio transcrito
      const desviou =
        /manda(r)? (por|em) (texto|escrito)|por escrito|n[ãa]o consigo ouvir|ajudar melhor por texto|prefiro (texto|que escreva)|s[óo] atend[eo] por texto/i.test(
          todas,
        );
      return {
        ok: informou && !desviou,
        nota: `informouValor=${informou} desviouParaTexto=${desviou} | resposta="${ultimo(t).resposta.slice(0, 120)}"`,
      };
    },
  },
  {
    nome: 'casal -> informa valor de casal (150/550)',
    falas: ['oi, e pra terapia de casal', 'quanto custa?'],
    checar: (t) => {
      const todas = todasRespostas(t);
      const informouCasal = /\b(150|550)\b|r\$\s?(150|550)/i.test(todas);
      return {
        ok: informouCasal,
        nota: `informouValorCasal=${informouCasal} | resposta="${ultimo(t).resposta.slice(0, 140)}"`,
      };
    },
  },
  {
    nome: 'escolheu pacote -> envia dados do Pix na hora e pede comprovante',
    falas: [
      'oi, quero agendar uma sessao individual',
      'sou a Carla Dias, ansiedade no trabalho, meu whatsapp e 11 96666-5555, posso quartas a tarde',
      'pode ser quarta as 15h sim',
      'prefiro o pacote mensal',
    ],
    checar: (t) => {
      const todas = todasRespostas(t);
      const temPix = /98117-8233|981178233/.test(todas);
      const pedeComprovante = /comprovante/i.test(todas);
      return {
        ok: temPix && pedeComprovante,
        nota: `pixNaResposta=${temPix} pedeComprovante=${pedeComprovante} | ultima="${ultimo(t).resposta.slice(0, 140)}"`,
      };
    },
  },
  {
    nome: 'devolveu a decisão -> Camila SUGERE uma abordagem e não repete (bug 19/07)',
    falas: [
      'oi, é pra terapia de casal',
      'nosso maior problema são as brigas',
      'qual a melhor abordagem pra o nosso caso?',
      'não entendo, seria melhor vocês sugerirem',
    ],
    checar: (t) => {
      const ultima = t[t.length - 1].res.resposta;
      const penultima = t[t.length - 2].res.resposta;
      const repetiu = ehRepeticao(ultima, penultima);
      const sugeriu = /tcc|cognitivo|humanist|psican/i.test(ultima);
      const devolveuPergunta = /vocês preferem|voces preferem|prefere alguma|quer(em)? que eu sugira/i.test(ultima);
      return {
        ok: !repetiu && sugeriu && !devolveuPergunta,
        nota: `repetiu=${repetiu} sugeriuAbordagem=${sugeriu} devolveuPergunta=${devolveuPergunta} | ultima="${ultima.slice(0, 140)}"`,
      };
    },
  },
  {
    nome: 'comprovante em imagem -> confirma e marca enviarForm',
    falas: [
      'oi, quero agendar uma sessao individual',
      'meu nome e Carla Dias, ando com muita ansiedade no trabalho',
      'meu whatsapp e 11 96666-5555 e consigo quartas a tarde',
      'pode agendar sim, obrigada',
      'pode ser quarta as 15h, prefiro a sessao avulsa',
      montarMarcadorComprovante(ANALISE_OK, 'confere'),
    ],
    checar: (t) => {
      const enviou = t.some((x) => x.res.enviarForm);
      return {
        ok: enviou,
        nota: `enviarForm=${enviou} | ultimaResposta="${ultimo(t).resposta.slice(0, 140)}"`,
      };
    },
  },
  {
    nome: 'nome abreviado -> aceita sem cobrar o completo',
    falas: ['oi, quero agendar uma sessao individual', 'meu nome é Murilo M', 'ando com muita ansiedade no trabalho'],
    checar: (t) => {
      const aposNome = t[1].res.resposta;
      const naoCobrou = !/nome complet|completinho/i.test(aposNome);
      const nomeFinal = t[t.length - 1].res.lead.nome || '';
      const capturou = /murilo/i.test(nomeFinal);
      return { ok: naoCobrou && capturou, nota: `naoCobrouCompleto=${naoCobrou} nomeFinal="${nomeFinal}"` };
    },
  },
  {
    nome: 'comprovante com VALOR errado -> aponta e NAO envia form',
    falas: [
      'oi, quero agendar uma sessao individual',
      'sou a Carla Dias, ansiedade no trabalho, meu whatsapp e 11 96666-5555, posso quartas a tarde',
      'pode ser quarta as 15h sim',
      'prefiro a sessao avulsa',
      montarMarcadorComprovante({ ...ANALISE_OK, valor: 550 }, 'confere'), // pagou 550, combinado 75
    ],
    checar: (t) => {
      const enviou = t.some((x) => x.res.enviarForm);
      const ultima = t[t.length - 1].res.resposta;
      const apontou = /valor|R\$/i.test(ultima) && /verific|confer|diferen/i.test(ultima);
      return {
        ok: !enviou && apontou,
        nota: `enviarForm=${enviou} apontouValor=${apontou} | ultima="${ultima.slice(0, 140)}"`,
      };
    },
  },
  {
    nome: 'comprovante com CHAVE errada -> nao confirma e reenvia o Pix',
    falas: [
      'oi, quero agendar uma sessao individual',
      'sou a Carla Dias, ansiedade no trabalho, meu whatsapp e 11 96666-5555, posso quartas a tarde',
      'pode ser quarta as 15h sim',
      'prefiro a sessao avulsa',
      montarMarcadorComprovante({ ...ANALISE_OK, chaveDestino: '+55 11 91234-5678' }, 'nao_confere'),
    ],
    checar: (t) => {
      const enviou = t.some((x) => x.res.enviarForm);
      const ultima = t[t.length - 1].res.resposta;
      const avisou = /destinat|outra? (conta|chave)|chave( pix)? diferente|diferente da nossa|n[ãa]o confere/i.test(ultima);
      return {
        ok: !enviou && avisou,
        nota: `enviarForm=${enviou} avisouDestinatario=${avisou} | ultima="${ultima.slice(0, 140)}"`,
      };
    },
  },
  {
    nome: 'pergunta preço -> informação inicial traz modalidade + valores',
    falas: ['oi, quanto custa a sessão?'],
    checar: (t) => {
      const r = ultimo(t).resposta.toLowerCase();
      const temModalidade = /online|v[íi]deo|45\s?min|45 minutos/.test(r);
      const temValor = /75|280/.test(r);
      const temPix = /pix/.test(r);
      return {
        ok: temModalidade && temValor,
        nota: `modalidade=${temModalidade} valor=${temValor} pix=${temPix} | "${ultimo(t).resposta.slice(0, 160)}"`,
      };
    },
  },
  {
    nome: 'pergunta próximos passos -> menciona o formulário de triagem',
    falas: ['oi, quero agendar uma sessao individual', 'depois que eu pagar, quais são os próximos passos?'],
    checar: (t) => {
      const r = ultimo(t).resposta.toLowerCase();
      const mencionaFormulario = /formul[áa]rio/.test(r);
      return { ok: mencionaFormulario, nota: `mencionaFormulario=${mencionaFormulario} | "${ultimo(t).resposta.slice(0, 160)}"` };
    },
  },
  {
    nome: 'info inicial -> quebra em bolhas e ja puxa o proximo passo',
    falas: ['oi, quanto custa a sessão individual?'],
    checar: (t) => {
      const resp = ultimo(t).resposta;
      const bolhas = splitReply(resp).length;
      const temValor = /75|280/.test(resp);
      const puxou = /chamar|seu nome|te trouxe|motivou|individual ou.*casal|agendar|\?/i.test(resp);
      return { ok: bolhas >= 2 && temValor && puxou, nota: `bolhas=${bolhas} temValor=${temValor} puxou=${puxou} | "${resp.slice(0, 160)}"` };
    },
  },
  {
    nome: 'acolhe a dor e CONTINUA no mesmo turno (nao para)',
    falas: ['oi, quero uma sessao individual', 'meu nome é Murilo', 'ando muito pra baixo, acho que é depressao'],
    checar: (t) => {
      const resp = ultimo(t).resposta;
      const acolheu = /sinto muito|imagino|que bom que|passo importante|difícil|dif[íi]cil/i.test(resp);
      const puxou = /dia|hor[áa]rio|per[íi]odo|melhor.*(voc[êe]|pra você)|agendar|\?/i.test(resp);
      return { ok: acolheu && puxou, nota: `acolheu=${acolheu} puxouProximo=${puxou} | "${resp.slice(0, 160)}"` };
    },
  },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function rodarCenario(c: Cenario): Promise<boolean> {
  console.log(`\n[1m=== ${c.nome} ===[0m`);
  const history: { role: 'user' | 'assistant'; content: string }[] = [];
  const turnos: Turno[] = [];
  for (const fala of c.falas) {
    history.push({ role: 'user', content: fala });
    const res = await runTriagemSemRepeticao({ system: SYSTEM, messages: history });
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
