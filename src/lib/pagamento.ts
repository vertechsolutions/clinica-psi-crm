/**
 * Portão do pagamento: a Camila não pede Pix nem comprovante antes de existir um
 * horário concreto ACEITO pelo paciente. Funções puras.
 *
 * Pedida da Bruna por áudio (11/08/2026): *"a IA tá empurrando muito os
 * pagamentos antes da hora. Logo no início da conversa, pedindo comprovante. Às
 * vezes o paciente nem falou um pouquinho da queixa, ou até nem verificou se pode
 * tal horário, nem olhou a disponibilidade de horário e ela já tá empurrando que
 * o paciente envie o comprovante."* No print ela conclui: *"Essa ela não
 * agendou... eu assumi o atendimento pra não perder o paciente."*
 *
 * A causa NÃO é o modelo desobedecendo por acaso: é uma contradição dentro do
 * prompt. `default-prompt.ts:138` diz "sem um horário REAL confirmado e aceito
 * pelo paciente, NÃO avance para o pagamento" e `:143` manda enviar o Pix "assim
 * que o paciente escolher avulsa ou pacote", sem condicional nenhuma. Entre uma
 * regra e um imperativo concreto, o modelo segue o imperativo. As duas linhas
 * foram corrigidas, e este arquivo é a garantia — o prompt efetivo vem do
 * `app_config` no Postgres e pode estar congelado numa versão antiga.
 *
 * ASSIMETRIA DE CUSTO, que governa cada decisão abaixo: segurar o Pix de quem já
 * combinou horário atrasa a venda em UM turno (a pessoa pergunta "e o
 * pagamento?", e a exceção do `pacientePediuPagamento` abre na hora). Mandar o
 * Pix cedo demais é o que fez a psicóloga assumir o chat à mão para não perder o
 * paciente. Por isso o portão fecha na dúvida — mas a definição de "dúvida" é
 * estreita de propósito, e metade dos testes deste módulo é negativa.
 */

/** Onde o funil está, do ponto de vista do pagamento. */
export interface EstadoPagamento {
  /** etapa 6: proposta concreta + aceite do paciente, nessa ordem */
  horarioAceito: boolean;
  /** etapa 4 — só escolhe a frase de substituição, não bloqueia */
  queixaColetada: boolean;
  /** etapa 5 — idem */
  disponibilidade: boolean;
}

/** Trechos de `PIX_INFO` longos o bastante para identificarem a chave. */
function fragmentosDaChave(pixInfo: string): string[] {
  return (pixInfo ?? '')
    .split(/[\s,;()—–-]+/)
    .map((t) => t.replace(/[.\/]/g, ''))
    .filter((t) => t.length >= 8 && /[0-9a-zA-Z]/.test(t));
}

/** Pedido de comprovante DIRIGIDO ao paciente (imperativo), não explicação. */
const PEDE_COMPROVANTE = /\bcomprovante\b/i;
const IMPERATIVO_DE_ENVIO = /\b(me\s+)?(envi[ae]|envia|mand[ae]|manda|encaminh[ae])\b/i;
const MENCIONA_CHAVE = /chave\s*(pix|cnpj|do\s+pix)|dados\s+(do|para\s+o)\s+(pix|pagamento)/i;
const PLACEHOLDER = /\{PIX_INFO\}/;

/**
 * A resposta tenta entregar Pix ou cobrar comprovante?
 *
 * ARMADILHA que custou o desenho: o `{PIX_INFO}` é substituído na ENTRADA do
 * system prompt (`conversation.ts`), então o que o modelo copia em produção é a
 * CHAVE LITERAL — procurar só o placeholder não pegaria praticamente nada. Daí a
 * busca por fragmentos da própria `PIX_INFO`.
 *
 * O termo do comprovante exige o verbo de envio dirigido ao paciente. Sem isso,
 * a explicação legítima do processo ("o formulário vem depois do comprovante",
 * `default-prompt.ts:108`) seria acusada e substituída por uma frase genérica —
 * um estrago pior que o defeito.
 */
export function tentaCobrar(resposta: string, pixInfo: string): boolean {
  const r = resposta ?? '';
  if (!r) return false;
  if (PLACEHOLDER.test(r)) return true;
  if (MENCIONA_CHAVE.test(r)) return true;
  const semPontuacao = r.replace(/[.\/]/g, '');
  if (fragmentosDaChave(pixInfo).some((f) => semPontuacao.includes(f))) return true;
  return PEDE_COMPROVANTE.test(r) && IMPERATIVO_DE_ENVIO.test(r);
}

/**
 * O paciente pediu o pagamento com todas as letras?
 *
 * Esta é a EXCEÇÃO que impede o guard de virar travão de faturamento. Negar a
 * chave Pix a quem está com o celular na mão é o pior desfecho comercial
 * possível, e não é do que a cliente reclamou — ela reclamou de EMPURRAR, não de
 * responder. Escolher "avulsa ou pacote" de propósito NÃO conta: é exatamente o
 * gatilho do print.
 */
export function pacientePediuPagamento(ultimaDoUser: string): boolean {
  const t = ultimaDoUser ?? '';
  if (!t) return false;
  // "quero pagar", "como eu pago", "onde eu pago"
  if (/\b(quero\s+pagar|vou\s+pagar\s+agora|pagar\s+agora|como\s+(eu\s+)?(pago|fa[çc]o\s+pra\s+pagar)|onde\s+(eu\s+)?pago)\b/i.test(t))
    return true;
  // "qual é a chave?", "qual o pix?"
  if (/\bqual\s+(é\s+|e\s+)?(a\s+|o\s+)?(chave|pix)\b/i.test(t)) return true;
  // verbo de pedido + objeto de pagamento, em qualquer ordem dentro da frase:
  // "me manda a chave do Pix", "pode passar os dados do pagamento"
  const verbo = /\b(mand[ae]|mandar|envi[ae]|enviar|pass[ae]|passar)\b/i;
  const objeto = /\b(pix|chave|dados\s+(do|de|para\s+o)\s+(pix|pagamento)|dados\s+banc)/i;
  return verbo.test(t) && objeto.test(t);
}

/**
 * O portão. Regra única: horário aceito.
 *
 * Só o horário bloqueia, e não a queixa nem a disponibilidade, porque o funil é
 * ordem SUGERIDA, não contrato: quem chega dizendo "quero marcar, sou o João,
 * quinta às 10h serve" não pode ser obrigado a contar a queixa antes de pagar. E
 * o horário é literalmente o que a Bruna descreve como faltando ("nem verificou
 * se pode tal horário").
 */
export function liberadoParaPagamento(e: EstadoPagamento): boolean {
  return e.horarioAceito === true;
}

/** A primeira etapa pendente do funil — escolhe a frase de substituição. */
export function etapaQueFalta(e: EstadoPagamento): 'queixa' | 'disponibilidade' | 'horario' {
  if (!e.queixaColetada) return 'queixa';
  if (!e.disponibilidade) return 'disponibilidade';
  return 'horario';
}

/**
 * Texto determinístico para quando o retry não resolveu — mesmo papel do
 * `mensagemAnexoInvalido` no backstop de comprovante: a clínica escreve, não o
 * modelo.
 *
 * Reconhece a escolha do paciente (senão a resposta soa como se a Camila não
 * tivesse lido) e puxa a etapa pendente com uma pergunta, para não brigar com o
 * guard de condução.
 */
export function mensagemAntesDoPagamento(etapa: 'queixa' | 'disponibilidade' | 'horario'): string {
  const abertura = 'Perfeito, já anotei a sua escolha aqui.';
  if (etapa === 'queixa') {
    return `${abertura} Antes de fechar, me conta um pouco: o que te trouxe a buscar terapia agora?`;
  }
  if (etapa === 'disponibilidade') {
    return `${abertura} Para eu achar o melhor horário, quais dias e períodos costumam funcionar melhor pra você?`;
  }
  return `${abertura} Só falta acertarmos o horário. Vou confirmar a agenda e já te proponho uma opção concreta — qual período é melhor pra você?`;
}
