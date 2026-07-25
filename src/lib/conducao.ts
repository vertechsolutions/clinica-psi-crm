// Guard determinístico de CONDUÇÃO: detecta quando a Camila "parou" (acolheu/
// informou e não puxou o próximo passo) — bug reportado pela Bruna em 25/07 e
// recorrente nos logs. Regra de prompt é probabilística; esta camada garante.

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

/**
 * true se a resposta NÃO avança o funil: sem pergunta ("?"), e não é fechamento
 * legítimo nem pedido de ação (Pix/comprovante). Vazio retorna false (o caller
 * trata resposta vazia com a mensagem amigável).
 */
export function terminaSemAvancar(resposta: string): boolean {
  const r = (resposta ?? '').trim();
  if (!r) return false;
  if (r.includes('?')) return false;
  if (ehFechamentoLegitimo(r)) return false;
  if (pedeAcaoDoPaciente(r)) return false;
  return true;
}
