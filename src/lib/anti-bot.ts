/**
 * Detecção de bot do outro lado — terceira pedida da Bruna (06/08/2026): quando
 * quem responde é um robô, a Camila entra num loop de duas máquinas conversando.
 * Cara em token e ridículo de ler no histórico.
 *
 * Arquivo próprio, e não dentro do `anti-repeat`: aquele guarda a ASSISTENTE
 * contra auto-repetição dentro de um turno e é consumido pelo wrapper da
 * triagem; este avalia o LEAD ao longo de vários turnos e tem outra ação
 * (pausar a conversa e chamar a equipe). Misturar os dois faria um limiar
 * calibrado para uma coisa governar a outra.
 *
 * Puro: nada de banco, nada de rede.
 */
import { normalizaComparacao } from './anti-repeat';
import type { MensagemHistorico } from './retomada';

export interface TurnoLogico {
  role: 'user' | 'assistant';
  /** o texto ORIGINAL, junto — a normalização acontece só na comparação */
  texto: string;
  /** quantas linhas de `wa_messages` viraram este turno (rajada debounced) */
  partes: number;
}

/**
 * Agrupa mensagens CONSECUTIVAS do mesmo papel num turno lógico.
 *
 * É o que impede o falso positivo mais óbvio: com o debounce, o lead ansioso que
 * manda "oi", "oi", "oi" gera três linhas em `wa_messages` mas recebe UMA
 * resposta — é um turno só. Sem agrupar, o anti-bot dispararia na primeira
 * interação da conversa e calaria justamente quem está mais aflito.
 *
 * Espera `hist` em ordem CRONOLÓGICA, que é o que `loadHistory` devolve.
 */
export function agruparPorTurno(hist: MensagemHistorico[]): TurnoLogico[] {
  const out: TurnoLogico[] = [];
  for (const m of hist) {
    const ultimo = out[out.length - 1];
    if (ultimo && ultimo.role === m.role) {
      ultimo.texto = `${ultimo.texto}\n${m.content}`;
      ultimo.partes++;
    } else {
      out.push({ role: m.role, texto: m.content, partes: 1 });
    }
  }
  return out;
}

/**
 * Normalização própria porque `normalizaComparacao` NÃO remove acento — ela
 * baixa a caixa, troca pontuação por espaço e colapsa. Um bot que alternasse
 * "atendimento" e "atendiménto" passaria batido. Tirar o diacrítico aqui, depois,
 * mantém o limiar de similaridade do `anti-repeat` intocado: ele é calibrado
 * para outra coisa.
 */
function normalizaTurno(s: string): string {
  return normalizaComparacao(s)
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}

/**
 * Turno gerado pelo SISTEMA, não digitado pelo lead: marcador de anexo
 * ("[o paciente enviou uma imagem...]"), "[áudio transcrito]", "[sticker]".
 */
const GERADO_PELO_SISTEMA = /^\s*\[/;

/**
 * Abaixo disto não é sinal de nada. "ok", "sim", "oi", "obrigada" repetidos são
 * gente conversando, não robô — e calar essa pessoa é pior do que aguentar a
 * repetição.
 */
const MIN_CARACTERES = 8;

/**
 * `true` quando os últimos `n` turnos do LEAD são o mesmo texto.
 *
 * Três guardas contra falso positivo, e a segunda existe por um caso concreto:
 *
 * 1. rajada debounced conta como UM turno (`agruparPorTurno`);
 * 2. turno gerado pelo sistema nunca julga — a MESMA foto reenviada três vezes
 *    produz três marcadores idênticos, e sem esta linha a gente pausaria um
 *    paciente que acabou de pagar, no exato momento em que ele mais precisa de
 *    resposta;
 * 3. texto curto demais é gente (`MIN_CARACTERES`).
 *
 * Falso negativo assumido: o turno-rajada `["oi","oi"]` vira "oi\noi" e não casa
 * com o turno `["oi"]`. É a direção segura do erro — deixar um bot conversar
 * custa token, calar um paciente custa o paciente.
 */
export function pareceBot(hist: MensagemHistorico[], n = 3): boolean {
  const doLead = agruparPorTurno(hist).filter((t) => t.role === 'user');
  if (doLead.length < n) return false;
  const ultimos = doLead.slice(-n);

  if (ultimos.some((t) => GERADO_PELO_SISTEMA.test(t.texto))) return false;

  const normalizados = ultimos.map((t) => normalizaTurno(t.texto));
  if (normalizados.some((t) => t.length < MIN_CARACTERES)) return false;
  return normalizados.every((t) => t === normalizados[0]);
}

/** Os últimos `n` turnos do lead, para o alerta que a equipe vai ler. */
export function ultimosTurnosDoLead(hist: MensagemHistorico[], n = 3): string[] {
  return agruparPorTurno(hist)
    .filter((t) => t.role === 'user')
    .slice(-n)
    .map((t) => t.texto);
}
