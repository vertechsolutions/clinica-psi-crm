// Trava determinística contra o bug de repetição verbatim (reportado pela Bruna
// em 19/07/2026): regra de prompt é probabilística e falhou em produção; esta
// camada de código garante que a resposta nunca sai igual à anterior.

import { runTriagem, type TriagemInput, type TriagemResult } from './triagem';
import { perguntasDe, repetePergunta, terminaSemAvancar } from './conducao';
import { tentaCobrar } from './pagamento';
import { normalizaComparacao, similaridade } from './texto';

// Moraram aqui até 11/08/2026; foram pro `texto.ts` porque o `conducao` passou a
// precisar delas e este arquivo já importa o `conducao` (o ciclo fecharia).
// Reexportadas para não quebrar quem já as importava daqui.
export { normalizaComparacao, similaridade };

/** Acima disso, a resposta nova é considerada repetição da anterior. */
const LIMIAR_REPETICAO = 0.9;

/** true se a resposta nova é igual (ou quase) à mensagem anterior da assistente. */
export function ehRepeticao(nova: string, anterior: string | undefined): boolean {
  if (!anterior) return false;
  const na = normalizaComparacao(nova);
  const nb = normalizaComparacao(anterior);
  if (!na || !nb) return false;
  if (na === nb) return true;
  return similaridade(nova, anterior) >= LIMIAR_REPETICAO;
}

const AVISO_RETRY = `

[AVISO DO SISTEMA — só neste turno]: a resposta que você tentou enviar repetia (quase) literalmente a sua última mensagem, e isso é proibido. Gere uma resposta NOVA:
- Se o paciente pediu uma sugestão ou devolveu a decisão pra você ("qual é melhor?", "sugere você"), DECIDA: sugira UMA opção concreta com justificativa curta e emende a próxima etapa do funil.
- Se o paciente pediu pra reenviar uma informação (ex.: dados do Pix, valores), reenvie os dados, mas com o texto em volta reformulado.
- Em qualquer caso: frases diferentes das da sua última mensagem, mais curto, avançando a conversa.`;

const AVISO_AVANCAR = `

[AVISO DO SISTEMA — só neste turno]: a resposta que você tentou enviar NÃO puxou o próximo passo (terminou sem uma pergunta que conduza a conversa). Isso é proibido no meio do atendimento. Gere uma resposta NOVA que:
- responda por INTEIRO o que o paciente trouxe (inclusive a pergunta que ele fez), acolhendo primeiro se for uma dor;
- e TERMINE puxando a próxima etapa pendente com UMA pergunta leve — nome só se ainda não souber; senão motivação, disponibilidade, ou propor um horário concreto da agenda.
Nunca encerre no acolhimento nem pare esperando o paciente dizer "ok".`;

/**
 * Quantas falas recentes da Camila entram no inventário de perguntas já feitas.
 *
 * 3 e não 1: a CTA reclamada pela Bruna reaparecia de dois em dois turnos, e uma
 * janela de 1 deixaria passar o padrão alternado. Mais que 3 começaria a proibir
 * a retomada legítima de uma etapa que o paciente nunca respondeu.
 */
const JANELA_PERGUNTAS = 3;

const AVISO_PERGUNTA_REPETIDA = `

[AVISO DO SISTEMA — só neste turno]: a pergunta com que você terminou é a MESMA que você já fez nos turnos anteriores. Repetir a mesma pergunta é o defeito nº 1 relatado pela clínica. Gere uma resposta NOVA que:
- puxe OUTRA etapa pendente do funil (motivação, disponibilidade, propor um horário concreto, avulsa ou pacote), não a mesma de antes;
- ou, se realmente não houver etapa nova, feche curto e SEM pergunta ("qualquer coisa é só me chamar").
Se o paciente PEDIU uma informação de novo (chave Pix, valor, link), reenvie a informação normalmente — mude só a pergunta final.`;

const AVISO_CEDO_DEMAIS = `

[AVISO DO SISTEMA — só neste turno]: você tentou mandar os dados do Pix ou pedir o comprovante, mas AINDA NÃO existe um horário concreto que o paciente tenha aceitado. Isso é proibido: o pagamento é o PENÚLTIMO passo do funil (etapa 8), nunca o segundo, e mandar a chave antes de agendar é a reclamação nº 1 da clínica. Gere uma resposta NOVA que:
- reconheça a escolha do paciente, se ele escolheu avulsa ou pacote ("perfeito, fica o pacote mensal então") — sem valor de Pix e sem pedir comprovante;
- e puxe a etapa que falta: o que a trouxe à terapia (4), a disponibilidade de dias e horários (5), ou uma proposta de horário concreto da agenda (6).
Escolher avulsa ou pacote NÃO libera o pagamento. Só o horário aceito libera.`;

/**
 * runTriagem com três travas determinísticas numa passada só (máx 2 chamadas ao
 * Gemini): se a resposta (a) sair igual/quase à última mensagem da assistente,
 * (b) não puxar o próximo passo do funil (e não for handoff/fechamento) ou
 * (c) terminar reciclando uma pergunta já feita, refaz UMA vez com o(s) aviso(s)
 * certo(s). Loga se persistir. Nunca entra em loop.
 *
 * Nenhuma das três bloqueia envio: o pior desfecho é a segunda tentativa sair
 * igual à primeira e ser enviada com um `console.error`. É essa a assimetria que
 * permite ser agressivo nos limiares.
 */
/**
 * O que o turno sabe sobre o funil e que o guard não consegue deduzir do texto.
 * Opcional em `runTriagemGuardada` para que a tela de teste (`/api/chat`) e os
 * harnesses sigam compilando sem mudança.
 */
export interface GuardasDoTurno {
  /** já existe horário concreto ACEITO pelo paciente (ou ele pediu o Pix) */
  pagamentoLiberado: boolean;
  /** a chave/dados que o modelo copiaria do prompt, pra reconhecer a cobrança */
  pixInfo: string;
}

/** O resultado da triagem mais o veredito do portão de pagamento. */
export type TriagemGuardada = TriagemResult & {
  /** a segunda tentativa AINDA tentou cobrar: quem chama troca o texto */
  cobrouCedo?: boolean;
};

export async function runTriagemGuardada(
  input: TriagemInput,
  guardas?: GuardasDoTurno,
): Promise<TriagemGuardada> {
  const anterior = [...input.messages].reverse().find((m) => m.role === 'assistant')?.content;
  // Inventário do que já foi perguntado, das últimas falas da Camila.
  const perguntasAnteriores = input.messages
    .filter((m) => m.role === 'assistant')
    .slice(-JANELA_PERGUNTAS)
    .flatMap((m) => perguntasDe(m.content));
  const cobrouCedo = (r: TriagemResult) =>
    Boolean(guardas) &&
    !guardas!.pagamentoLiberado &&
    !r.enviarForm &&
    tentaCobrar(r.resposta, guardas!.pixInfo);
  const primeira = await runTriagem(input);

  const repetiu = ehRepeticao(primeira.resposta, anterior);
  // só cobra avanço no meio do funil: nunca no handoff (enviarForm)
  const parou = !primeira.enviarForm && terminaSemAvancar(primeira.resposta, perguntasAnteriores);
  const cedo = cobrouCedo(primeira);
  if (!repetiu && !parou && !cedo) return primeira;

  let aviso = '';
  if (repetiu) aviso += AVISO_RETRY;
  if (parou) {
    // Distingue "não puxou nada" de "puxou a mesma coisa": o aviso genérico de
    // avanço mandaria terminar com pergunta, que é exatamente o que o modelo
    // acabou de fazer — e ele repetiria a CTA de novo.
    aviso += repetePergunta(primeira.resposta, perguntasAnteriores) ? AVISO_PERGUNTA_REPETIDA : AVISO_AVANCAR;
  }
  if (cedo) aviso += AVISO_CEDO_DEMAIS;
  console.warn(`[guard] refazendo (repetiu=${repetiu}, parou=${parou}, cedo=${cedo})`);
  const segunda = await runTriagem({ ...input, system: input.system + aviso });
  if (ehRepeticao(segunda.resposta, anterior)) {
    console.error('[guard] repetição persistiu após retry — enviando a 2ª tentativa mesmo assim');
  }
  if (!segunda.enviarForm && terminaSemAvancar(segunda.resposta, perguntasAnteriores)) {
    console.error('[guard] resposta ainda não avança após retry — enviando mesmo assim');
  }
  // Cobrança que insistiu depois do aviso é o único caso em que o texto do
  // modelo é DESCARTADO em vez de só regerado — quem chama troca a resposta pelo
  // texto da clínica. Mesmo idioma do backstop de comprovante em `turno.ts`.
  return { ...segunda, cobrouCedo: cobrouCedo(segunda) };
}

/** Compat: nome antigo usado pela route, webhook e harness de testes. */
export const runTriagemSemRepeticao = runTriagemGuardada;
