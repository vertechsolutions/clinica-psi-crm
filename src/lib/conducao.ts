// Guard determinístico de CONDUÇÃO: detecta quando a Camila "parou" (acolheu/
// informou e não puxou o próximo passo) — bug reportado pela Bruna em 25/07 e
// recorrente nos logs. Regra de prompt é probabilística; esta camada garante.
import { similaridade } from './texto';

/** Fechamento/limite legítimo: aí é OK a resposta não ter pergunta. */
const FECHAMENTO =
  /(à|a) disposi[çc]|te chamo por aqui|qualquer coisa (é só )?(me )?cham|fico no aguardo|estou (por aqui|à disposi)|mantermos o respeito/i;

/** Passo 3 (Pix/comprovante): pedir a ação do paciente conta como avanço, mesmo sem "?". */
const PEDE_ACAO =
  /comprovante|me (envie|manda|envia|mande)|assim que (voc[êe] )?(fizer|pagar|realizar)|chave (pix|do pix)|dados (do|para o) (pagamento|pix)/i;

export function ehFechamentoLegitimo(resposta: string): boolean {
  return FECHAMENTO.test(resposta ?? '');
}

export function pedeAcaoDoPaciente(resposta: string): boolean {
  return PEDE_ACAO.test(resposta ?? '');
}

/** As frases interrogativas de um texto — cada uma terminada em "?". */
export function perguntasDe(texto: string): string[] {
  return ((texto ?? '').match(/[^.!?…]*\?/g) ?? []).map((p) => p.trim()).filter(Boolean);
}

/**
 * Acima disso, duas perguntas contam como a mesma.
 *
 * Mais frouxo que o 0,9 do `ehRepeticao` de propósito: perguntas curtas variam
 * pouquíssimo, e "gostaria de agendar uma primeira sessão?" contra "gostaria de
 * agendar sua primeira sessão?" precisa casar — é essa a reformulação que
 * aparece nos prints.
 */
const LIMIAR_PERGUNTA = 0.8;

/**
 * A resposta só recicla perguntas já feitas? `true` quando TODAS as perguntas
 * dela casam com alguma anterior.
 *
 * "Todas", e não "alguma", porque uma resposta que traz uma pergunta nova junto
 * da CTA velha está avançando a conversa — acusá-la gastaria um retry do Gemini
 * para trocar uma resposta legítima.
 */
export function repetePergunta(resposta: string, anteriores: string[]): boolean {
  const novas = perguntasDe(resposta);
  if (novas.length === 0 || anteriores.length === 0) return false;
  return novas.every((n) => anteriores.some((a) => similaridade(n, a) >= LIMIAR_PERGUNTA));
}

/**
 * true se a resposta NÃO avança o funil: sem pergunta NOVA, e não é fechamento
 * legítimo nem pedido de ação (Pix/comprovante). Vazio retorna false (o caller
 * trata resposta vazia com a mensagem amigável).
 *
 * `perguntasAnteriores` (11/08/2026) é a correção do relato da Bruna por áudio:
 * *"sempre que o paciente responde algo, ela já encaminha 'você gostaria de
 * agendar uma consulta?'. Tá muito repetitivo."* Até então bastava um "?" —
 * inclusive o MESMO do turno anterior. Somado ao `default-prompt` exigindo que
 * toda resposta termine em pergunta, o guard não só tolerava a repetição: ele a
 * PREMIAVA, porque reemitir a CTA era o caminho mais curto para satisfazê-lo.
 *
 * Opcional para não quebrar call site nenhum: sem o argumento, a decisão é
 * exatamente a de antes.
 *
 * INVARIANTE deste arquivo: nada aqui bloqueia ou censura envio. O único efeito
 * de um `true` é o `runTriagemGuardada` refazer o turno uma vez. Por isso o
 * falso positivo custa um token, nunca um silêncio — e é o que permite ser
 * agressivo com o limiar sem risco de emudecer quem está pedindo ajuda.
 */
export function terminaSemAvancar(resposta: string, perguntasAnteriores: string[] = []): boolean {
  const r = (resposta ?? '').trim();
  if (!r) return false;
  if (r.includes('?') && !repetePergunta(r, perguntasAnteriores)) return false;
  if (ehFechamentoLegitimo(r)) return false;
  if (pedeAcaoDoPaciente(r)) return false;
  return true;
}
