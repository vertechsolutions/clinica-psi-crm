// Mensagens oficiais de encerramento da Clínica Cazule — texto definido pela
// Bruna em 27/07/2026 (prints do WhatsApp). Ficam no CÓDIGO, não no prompt: o
// texto é da clínica e cada item precisa sair como UMA bolha curta (o modelo
// juntava tudo num parágrafo só). Funções puras.
import { splitReply } from './split-message';
import { semEmoji } from './emoji';

/** Mensagem que entrega o formulário (o link é concatenado). */
export const FECHAMENTO_FORMULARIO =
  'Este é o nosso formulário, solicito que seja preenchido, pois é através dele que realizaremos o envio da sua triagem para a psicóloga:';

export const FECHAMENTO_CONFIRMACAO =
  'Confirmação realizada, após o preenchimento da triagem a psicóloga vai entrar em contato com você pelo WhatsApp.';

export const FECHAMENTO_DUVIDA = 'Caso tenha qualquer dúvida pode me chamar que eu te ajudo.';

export const FECHAMENTO_REMANEJAMENTO =
  'Caso você não se identifique com a profissional, podemos fazer o remanejamento para outra psicóloga, é só nos avisar.';

/**
 * As 4 bolhas do encerramento, na ordem definida pela Bruna. Uma mensagem de
 * WhatsApp por item — nada aqui passa pelo splitReply. Sem `formUrl` (ou com o
 * placeholder cru), a primeira sai sem link em vez de vazar `{FORM_URL}`.
 */
export function mensagensDeFechamento(formUrl: string): string[] {
  const link = (formUrl ?? '').trim();
  const valido = link.length > 0 && !link.includes('{');
  return [
    valido ? `${FECHAMENTO_FORMULARIO} ${link}` : FECHAMENTO_FORMULARIO,
    FECHAMENTO_CONFIRMACAO,
    FECHAMENTO_DUVIDA,
    FECHAMENTO_REMANEJAMENTO,
  ];
}

/**
 * ÚNICO ponto que decide o que o paciente recebe num turno: fechamento oficial
 * (handoff) ou a resposta do modelo repartida em bolhas. Chamado pelo webhook
 * DEPOIS dos backstops — se algum deles zerou `enviarForm`, nenhuma palavra do
 * fechamento sai. Os harnesses chamam a mesma função (fidelidade).
 *
 * O `semEmoji` no fim vale pros dois caminhos: a resposta do modelo (que às vezes
 * insiste na carinha mesmo com o prompt limpo) e as bolhas oficiais (hoje já
 * limpas — aqui é defesa contra edição futura). Filtrar DEPOIS do splitReply é de
 * propósito: o split usa a linha em branco pra decidir a bolha, e uma linha que
 * só tinha emoji não pode virar uma bolha vazia — vira string vazia, que o
 * `sendTextSequence` ignora.
 */
export function bolhasDoTurno(turno: { enviarForm: boolean; resposta: string }, formUrl: string): string[] {
  const bolhas = turno.enviarForm ? mensagensDeFechamento(formUrl) : splitReply(turno.resposta);
  return bolhas.map(semEmoji).filter(Boolean);
}
