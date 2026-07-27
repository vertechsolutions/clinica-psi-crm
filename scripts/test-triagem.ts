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
import { blocoContatoDe } from '../src/lib/contato';
import { blocoOndeParamos, type MensagemHistorico } from '../src/lib/retomada';

// Análise de comprovante VÁLIDA (avulsa individual, chave da clínica) — os
// cenários derivam variações dela. Usa a MESMA função da produção pra montar
// o marcador: fixture nunca desvia do que o webhook injeta de verdade.
const ANALISE_OK: AnaliseComprovante = {
  ehComprovante: true,
  valor: 75,
  nomeDestinatario: 'Cazule Psicologia',
  chaveDestino: '53480459000104',
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
    'Chave Pix (CNPJ): 53480459000104 — em nome de Cazule Psicologia',
  ) + `\n\n${AGENDA_FAKE}`;

type Turno = { fala: string; res: TriagemResult };

interface Cenario {
  nome: string;
  /** system alternativo (ex.: com bloco [DADOS DO CONTATO]); default = SYSTEM. */
  system?: string;
  /** histórico pré-existente (retomada): entra antes das falas e alimenta o bloco de retomada. */
  historico?: { role: 'user' | 'assistant'; content: string; at?: Date }[];
  /**
   * O system deste cenário já traz [DADOS DO CONTATO]? Espelha o
   * `{ temNome: Boolean(contato) }` do computeReply. Sem isso o bloco de retomada
   * manda "perguntar como pode chamar a pessoa" mesmo com o nome já conhecido —
   * exatamente o re-perguntar que a Bruna reportou em 25/07.
   */
  temNome?: boolean;
  falas: string[];
  checar: (t: Turno[]) => { ok: boolean; nota: string };
}

const ultimo = (t: Turno[]) => t[t.length - 1].res;
const algumPronto = (t: Turno[]) => t.some((x) => x.res.pronto);
const todasRespostas = (t: Turno[]) => t.map((x) => x.res.resposta).join('\n');
// informou valor: "R$ 75", "75 reais", "280", "avulsa", "pacote"
const informaValor = (s: string) => /r\$\s?\d|\b(75|280)\b|avulsa|pacote/i.test(s);
const citaAbordagem = (s: string) => /tcc|cognitivo|psican|humanist/i.test(s);
// Detecta o bloco [DADOS DO CONTATO] REALMENTE injetado no system. Tem que ser
// ancorado na linha: o próprio DEFAULT_PROMPT cita "[DADOS DO CONTATO]" no meio
// de uma frase ("ou há um bloco [DADOS DO CONTATO] no contexto"), e um simples
// includes() daria nome conhecido em TODOS os cenários — o oposto do bug.
const BLOCO_CONTATO_INJETADO = /^\[DADOS DO CONTATO\]$/m;

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
      const temPix = /53480459000104|53\.480\.459/.test(todas);
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
    nome: 'retomada no dia seguinte -> NAO repassa valores de novo',
    falas: ['bom dia, gostaria de agendar'],
    historico: [
      { role: 'user' as const, content: 'oi, quero terapia individual', at: new Date('2026-07-16T20:00:00Z') },
      {
        role: 'assistant' as const,
        content:
          'As sessões são online, por chamada de vídeo, com duração de 45 minutos 😊\n\nA avulsa é R$ 75,00 e o pacote mensal (4 sessões) sai por R$ 280,00. O pagamento é via Pix.\n\nComo posso te chamar?',
        at: new Date('2026-07-16T20:01:00Z'),
      },
      { role: 'user' as const, content: 'sou a Marina', at: new Date('2026-07-16T20:05:00Z') },
      { role: 'assistant' as const, content: 'Prazer, Marina! O que te trouxe à terapia agora?', at: new Date('2026-07-16T20:05:30Z') },
    ],
    checar: (t) => {
      const ultima = ultimo(t).resposta;
      const repassouValores = /r\$\s?(75|280)/i.test(ultima);
      const reabriu = /seja bem-?vind|me chamo camila/i.test(ultima);
      return {
        ok: !repassouValores && !reabriu,
        nota: `repassouValores=${repassouValores} reabriu=${reabriu} | ultima="${ultima.slice(0, 140)}"`,
      };
    },
  },
  {
    nome: 'paciente PEDE o valor de novo -> pode repetir',
    falas: ['qual era o valor mesmo?'],
    historico: [
      { role: 'user' as const, content: 'oi, quero terapia individual', at: new Date('2026-07-16T20:00:00Z') },
      {
        role: 'assistant' as const,
        content: 'A avulsa é R$ 75,00 e o pacote mensal (4 sessões) sai por R$ 280,00. O pagamento é via Pix.',
        at: new Date('2026-07-16T20:01:00Z'),
      },
      { role: 'user' as const, content: 'sou a Marina, ando ansiosa no trabalho', at: new Date('2026-07-16T20:03:00Z') },
      {
        role: 'assistant' as const,
        content: 'Imagino o quanto pesa, Marina. Quais dias funcionam melhor pra você?',
        at: new Date('2026-07-16T20:03:30Z'),
      },
    ],
    checar: (t) => {
      const ultima = ultimo(t).resposta;
      const reinformou = /r\$\s?(75|280)|\b(75|280)\b/i.test(ultima);
      return { ok: reinformou, nota: `reinformouValor=${reinformou} | ultima="${ultima.slice(0, 140)}"` };
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
  {
    nome: 'ja sabe o nome -> NAO re-pergunta (bug 25/07)',
    system: SYSTEM + '\n\n' + blocoContatoDe('Bruna', undefined),
    temNome: true,
    falas: ['Gostaria de terapia', 'Individual', 'existem profissionais com foco em abordagens diferentes?'],
    checar: (t) => {
      const todas = todasRespostas(t);
      const pediuNome = /como.*(te chamar|posso te chamar)|seu (primeiro )?nome|qual.*\bnome\b/i.test(todas);
      const usouNome = /bruna/i.test(todas);
      return { ok: !pediuNome && usouNome, nota: `pediuNome=${pediuNome} (esperado false) usouNome=${usouNome} | "${ultimo(t).resposta.slice(0, 140)}"` };
    },
  },
  {
    nome: 'nome conhecido + modalidade dita -> nao re-pergunta nada, informa e conduz',
    system: SYSTEM + '\n\n' + blocoContatoDe('Marina', undefined),
    temNome: true,
    falas: ['oi, gostaria de saber os valores da sessao individual'],
    checar: (t) => {
      const todas = todasRespostas(t);
      const perguntouModalidade = /individual ou (de )?casal/i.test(todas);
      const pediuNome = /como.*(te chamar|posso te chamar)|seu (primeiro )?nome/i.test(todas);
      const informou = informaValor(todas);
      return { ok: !perguntouModalidade && !pediuNome && informou, nota: `modalidade=${perguntouModalidade} pediuNome=${pediuNome} informou=${informou} | "${ultimo(t).resposta.slice(0, 140)}"` };
    },
  },
  {
    nome: 'pergunta com typo (bournat=burnout) -> aborda a pergunta e conduz',
    falas: ['oi, quero uma sessao individual', 'meu nome é Helena', 'Tenho dificuldade para dormir é possível bournat'],
    checar: (t) => {
      const ultima = ultimo(t).resposta;
      const abordou = /burnout|esgotamento|é possível|d[áa] pra (investigar|cuidar|trabalhar)|pode (ser|estar) (ligad|relacion)|trabalhad[ao]/i.test(ultima);
      const puxou = /\?/.test(ultima);
      const naoDiagnosticou = !/voc[êe] (tem|est[áa] com) burnout|é burnout sim/i.test(ultima);
      return { ok: abordou && puxou && naoDiagnosticou, nota: `abordou=${abordou} puxou=${puxou} semDiagnostico=${naoDiagnosticou} | "${ultima.slice(0, 160)}"` };
    },
  },
  {
    nome: 'deu disponibilidade -> propoe horario concreto (nao para) [bug 20/07]',
    falas: ['oi, quero uma sessao individual', 'meu nome é Helena, ando ansiosa', 'quinta à tarde'],
    checar: (t) => {
      const ultima = ultimo(t).resposta;
      // agenda fake: Bruna Ferreira quinta 14:00-19:00 -> deve propor slot concreto
      const propos = /\b1[4-9]h|1[4-9]:00|reserv/i.test(ultima);
      const puxou = /\?/.test(ultima) || /reserv/i.test(ultima);
      return { ok: propos && puxou, nota: `propos=${propos} puxou=${puxou} | "${ultima.slice(0, 160)}"` };
    },
  },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function rodarCenario(c: Cenario): Promise<boolean> {
  console.log(`\n[1m=== ${c.nome} ===[0m`);
  const history: MensagemHistorico[] = [...(c.historico ?? [])];
  const systemBase = c.system ?? SYSTEM;
  // Espelha o computeReply: lá o temNome vem do [DADOS DO CONTATO]. Sem ele, os
  // cenários de nome conhecido recebiam "Próxima etapa pendente: perguntar como
  // pode chamar a pessoa" — o próprio bug de 25/07 que eles deveriam reprovar.
  const temNome = c.temNome ?? BLOCO_CONTATO_INJETADO.test(systemBase);
  // Em produção o loadHistory traz created_at em TODAS as linhas, e é o gap entre
  // as duas últimas que escolhe [JÁ TRATADO] x [ONDE PARAMOS]. Sem carimbo o
  // extrairSinais devolvia horas=null e o cenário de retomada caía sempre no ramo
  // factual — nunca exercitando a única instrução anti-reabertura do módulo.
  // O turno começa um dia depois do último item do histórico (as fixtures são de
  // 16/07) pra o intervalo ser real; sem histórico, agora mesmo já basta.
  const fimDoHistorico = c.historico?.[c.historico.length - 1]?.at;
  let relogio = fimDoHistorico ? new Date(fimDoHistorico.getTime() + 24 * 3_600_000) : new Date();
  const turnos: Turno[] = [];
  for (const fala of c.falas) {
    history.push({ role: 'user', content: fala, at: relogio });
    // espelha o computeReply: o bloco de retomada é remontado a cada turno
    const ondeParamos = blocoOndeParamos(history, { temNome });
    const res = await runTriagemSemRepeticao({
      system: ondeParamos ? `${systemBase}\n\n${ondeParamos}` : systemBase,
      messages: history.map(({ role, content }) => ({ role, content })),
    });
    history.push({ role: 'assistant', content: res.resposta, at: relogio });
    // os turnos seguintes correm minuto a minuto: só a volta do paciente é que
    // tem gap de retomada, o resto da conversa é contínuo como no WhatsApp real
    relogio = new Date(relogio.getTime() + 60_000);
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
  // filtro opcional por substring do nome: npx tsx ... test-triagem.ts retomada
  const filtro = (process.argv[2] ?? '').toLowerCase();
  const selecionados = filtro ? cenarios.filter((c) => c.nome.toLowerCase().includes(filtro)) : cenarios;
  let pass = 0;
  for (const c of selecionados) {
    try {
      if (await rodarCenario(c)) pass++;
    } catch (e) {
      console.log(`  [31mERRO[0m ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`\n[1mResultado: ${pass}/${selecionados.length} cenarios passaram[0m`);
  process.exit(pass === selecionados.length ? 0 : 1);
}

main();
