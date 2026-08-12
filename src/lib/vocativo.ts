/**
 * Orçamento de vocativo: quantas vezes a Camila pode chamar o paciente pelo
 * nome. Funções puras.
 *
 * Pedida da Bruna (11/08/2026): "Acho que ela está repetindo muito o nome em
 * todas as conversas, seria possível retirar?" Nos prints são quatro turnos
 * seguidos — "Entendi, Eldilaine." / "Ótimo, Eldilaine!" / "Perfeito,
 * Eldilaine!" / "De nada, Eldilaine!".
 *
 * A origem é o bloco `[DADOS DO CONTATO]` (`contato.ts`), injetado a CADA turno
 * dizendo "use o nome com naturalidade" — o modelo lê isso como licença por
 * turno. Corrigir só lá não bastaria: o prompt efetivo vem do `app_config` no
 * Postgres (`conversation.getActivePrompt`) e pode estar congelado numa versão
 * antiga. Por isso a garantia é de código, como já são o anti-repetição e a
 * condução.
 *
 * O risco desta camada NÃO é deixar passar um "Eldilaine" a mais — é mutilar
 * uma frase legítima, que seria o defeito da bolha cortada voltando pela porta
 * dos fundos. Daí os três padrões estreitos abaixo, todos exigindo pontuação de
 * vocativo, e a rede de segurança no fim do `podarVocativo`.
 */
import type { MensagemHistorico } from './retomada';

/**
 * Quantas falas recentes da Camila a poda olha para trás.
 *
 * 2, e não 1: com janela 1 a corrente do print viraria nome-sim-nome-não, que
 * ainda soa robótico. Com 2 o nome sai no máximo uma vez a cada três mensagens
 * — o ritmo de uma recepcionista de verdade.
 */
export const JANELA_VOCATIVO = 2;

/**
 * Folga máxima, em caracteres, que uma poda pode comer ALÉM do nome — a vírgula,
 * os espaços e a pontuação de vocativo. Uma ocorrência que removeria mais que
 * isso é sinal de regex passando do ponto, e é descartada.
 *
 * Rede medida no lugar certo. A tentação é conferir a proporção do texto que
 * sobrou, mas em "Entendi, Eldilaine." o nome é 42% da frase — um piso
 * proporcional descartaria justamente o caso do print.
 */
const FOLGA_MAXIMA = 4;

/** Variantes acentuadas por letra-base — a ficha e a fala nem sempre concordam. */
const VARIANTES: Record<string, string> = {
  a: 'aáàâãä',
  e: 'eéèêë',
  i: 'iíìîï',
  o: 'oóòôõö',
  u: 'uúùûü',
  c: 'cç',
  n: 'nñ',
  y: 'yýÿ',
};

/** Classe de caractere que casa a letra em qualquer caixa e com ou sem acento. */
function classeDe(ch: string): string | null {
  const base = (ch.normalize('NFD')[0] ?? ch).toLowerCase();
  if (!/\p{L}/u.test(base)) return null; // dígito, símbolo, espaço: nome inválido
  const variantes = VARIANTES[base] ?? base;
  return `[${variantes}${variantes.toUpperCase()}]`;
}

/**
 * O nome virado em regex tolerante a caixa e acento — `null` quando o nome não
 * serve (vazio, só espaço, ou com algo que não é letra).
 */
function padraoDoNome(nome: string | null | undefined): string | null {
  const limpo = (nome ?? '').trim();
  if (limpo.length < 2) return null;
  const classes: string[] = [];
  for (const ch of limpo) {
    const c = classeDe(ch);
    if (!c) return null;
    classes.push(c);
  }
  return classes.join('');
}

interface Ocorrencia {
  inicio: number;
  fim: number;
  /** o que fica no lugar do trecho removido (o prefixo que o padrão preservou) */
  mantem: string;
  /** a letra seguinte precisa virar maiúscula? (vocativo que abria a frase) */
  recapitaliza: boolean;
}

/**
 * Os três — e SÓ os três — padrões que contam como vocativo. Todos exigem
 * pontuação de vocativo adjacente, e é isso que separa o vício de estilo do
 * conteúdo: "vou anotar o nome Eldilaine na ficha" não casa com nenhum.
 */
function ocorrenciasDe(texto: string, padrao: string): Ocorrencia[] {
  const fim = '(?=$|[\\s.,;:!?…])';
  const achados: Ocorrencia[] = [];

  // (a) posposto — o do print: "Entendi, Eldilaine!" → "Entendi!"
  for (const m of texto.matchAll(new RegExp(`,\\s*${padrao}${fim}`, 'gu'))) {
    achados.push({ inicio: m.index, fim: m.index + m[0].length, mantem: '', recapitaliza: false });
  }

  // (b) anteposto — "Eldilaine, o que acontece" → "O que acontece"
  for (const m of texto.matchAll(new RegExp(`(^|[.!?…]\\s+)${padrao}\\s*,\\s*`, 'gu'))) {
    achados.push({
      inicio: m.index,
      fim: m.index + m[0].length,
      mantem: m[1],
      recapitaliza: true,
    });
  }

  // (c) saudação sem vírgula — "Oi Eldilaine!" → "Oi!"
  const saudacao = '(oi|ol[áa]|opa|bom dia|boa tarde|boa noite)';
  for (const m of texto.matchAll(new RegExp(`(^|[.!?…]\\s+)${saudacao}(\\s+)${padrao}${fim}`, 'giu'))) {
    achados.push({
      inicio: m.index,
      fim: m.index + m[0].length,
      mantem: m[1] + m[2],
      recapitaliza: false,
    });
  }

  // Ordem do texto, sem sobreposição: dois padrões podem casar o MESMO nome
  // (ex.: "Oi, Ana," pega o posposto e o anteposto) e removê-lo duas vezes
  // comeria a frase em volta.
  achados.sort((x, y) => x.inicio - y.inicio || y.fim - x.fim);
  const limpos: Ocorrencia[] = [];
  for (const o of achados) {
    if (limpos.length === 0 || o.inicio >= limpos[limpos.length - 1].fim) limpos.push(o);
  }
  return limpos;
}

/** Quantas vezes o nome aparece como VOCATIVO (uso como conteúdo não conta). */
export function contarVocativos(texto: string, nome: string): number {
  const padrao = padraoDoNome(nome);
  if (!padrao || !texto) return 0;
  return ocorrenciasDe(texto, padrao).length;
}

/**
 * Remove os vocativos EXCEDENTES, mantendo os `permitidos` primeiros — a
 * primeira ocorrência costuma ser a saudação, o único lugar em que chamar pelo
 * nome soa natural.
 *
 * Falha ABERTA: qualquer erro, nome inválido, ou poda que devore mais que o
 * razoável do texto devolve o original intacto. A assimetria está declarada no
 * topo do arquivo.
 */
export function podarVocativo(texto: string, nome: string | null | undefined, permitidos: number): string {
  if (!texto) return texto;
  const padrao = padraoDoNome(nome);
  if (!padrao) return texto;
  const tamanhoDoNome = (nome ?? '').trim().length;
  try {
    const excedentes = ocorrenciasDe(texto, padrao)
      .slice(Math.max(0, permitidos))
      // o que sai é o trecho casado MENOS o prefixo preservado: tem que ser o
      // nome mais a pontuação de vocativo, nunca uma mordida na frase
      .filter((o) => o.fim - o.inicio - o.mantem.length <= tamanhoDoNome + FOLGA_MAXIMA);
    if (excedentes.length === 0) return texto;

    // De trás pra frente: cortar pela frente invalidaria os índices seguintes.
    let out = texto;
    for (let i = excedentes.length - 1; i >= 0; i--) {
      const o = excedentes[i];
      const depois = out.slice(o.fim);
      const ajustado = o.recapitaliza ? depois.replace(/^\p{Ll}/u, (c) => c.toUpperCase()) : depois;
      out = out.slice(0, o.inicio) + o.mantem + ajustado;
    }

    // Higiene: a poda deixa espaço sobrando e pontuação órfã. Só espaço
    // HORIZONTAL — colapsar `\n\n` aqui destruiria a separação de bolhas que o
    // `splitReply` lê, trocando o defeito do nome pelo defeito da bolha.
    out = out
      .replace(/[ \t]+([.,;:!?…])/g, '$1')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .trim();

    if (!out) {
      console.warn('[vocativo] poda esvaziou a resposta — devolvendo o original.');
      return texto;
    }
    return out;
  } catch (e) {
    console.error('[vocativo] poda falhou — devolvendo o texto original', e);
    return texto;
  }
}

/**
 * Quantos vocativos este turno pode gastar: 1 se o nome não apareceu nas
 * últimas `k` falas da Camila, 0 se apareceu.
 *
 * Olha só as mensagens `assistant` porque o paciente escrever o próprio nome
 * ("sou a Ana") não é vício de estilo da atendente.
 */
export function orcamentoDeVocativo(
  hist: MensagemHistorico[],
  nome: string | null | undefined,
  k: number = JANELA_VOCATIVO,
): 0 | 1 {
  const padrao = padraoDoNome(nome);
  if (!padrao) return 0;
  const recentes = hist.filter((m) => m.role === 'assistant').slice(-k);
  return recentes.some((m) => ocorrenciasDe(m.content, padrao).length > 0) ? 0 : 1;
}
