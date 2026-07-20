// Núcleo PURO da validação de comprovante Pix (sem I/O — testável).
// A análise da imagem (Gemini vision) fica em comprovante.ts; aqui entram a
// comparação do destinatário com a chave da clínica e a montagem do marcador
// que vai pro histórico da conversa (o prompt decide o VALOR — só ele sabe o
// que foi combinado com o paciente).

export interface AnaliseComprovante {
  ehComprovante: boolean;
  valor: number | null; // em reais (ex.: 280)
  nomeDestinatario: string | null; // quem RECEBEU
  chaveDestino: string | null; // chave Pix do destinatário como aparece
  instituicao: string | null;
  dataHora: string | null;
}

export type VerificacaoDestinatario = 'confere' | 'nao_confere' | 'inconclusivo';

const digitos = (s: string) => s.replace(/\D/g, '');
const normaliza = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * Compara o destinatário extraído do comprovante com a chave esperada da
 * clínica (texto livre da env PIX_INFO ou PIX_CHAVE). Tolerante a formatos:
 * chaves numéricas comparam pelo SUFIXO de 8+ dígitos; e-mail por containment;
 * sem chave legível, o nome do destinatário vale como sinal fraco (bate →
 * confere; não bate → inconclusivo, nunca acusa por OCR de nome).
 */
export function verificarDestinatario(
  analise: AnaliseComprovante,
  esperadoRaw: string,
): VerificacaoDestinatario {
  const expDig = digitos(esperadoRaw);
  const chave = analise.chaveDestino?.trim() || '';
  const chaveDig = digitos(chave);

  if (chaveDig.length >= 8 && expDig.length >= 8) {
    return chaveDig.slice(-8) === expDig.slice(-8) ? 'confere' : 'nao_confere';
  }
  if (chave.includes('@')) {
    return normaliza(esperadoRaw).includes(normaliza(chave)) ? 'confere' : 'nao_confere';
  }
  // sem chave comparável: tenta o nome (sinal fraco)
  const nome = analise.nomeDestinatario?.trim();
  if (nome) {
    const esperadoNorm = normaliza(esperadoRaw);
    const bateNome = normaliza(nome)
      .split(/\s+/)
      .some((p) => p.length >= 4 && esperadoNorm.includes(p));
    if (bateNome) return 'confere';
  }
  return 'inconclusivo';
}

/**
 * Marcador injetado no histórico no lugar da imagem. Único ponto que gera esse
 * texto (os testes usam a MESMA função — fixture nunca desvia da produção).
 */
export function montarMarcadorComprovante(
  analise: AnaliseComprovante | null,
  verificacao: VerificacaoDestinatario,
): string {
  if (analise === null) {
    return (
      '[o paciente enviou uma imagem/anexo pelo WhatsApp — análise automática indisponível. ' +
      'Se o pagamento acabou de ser combinado, trate como possível comprovante e siga o fluxo normal; a equipe confere manualmente.]'
    );
  }
  if (!analise.ehComprovante) {
    return (
      '[o paciente enviou uma imagem pelo WhatsApp. Análise automática: a imagem NÃO parece ser um comprovante de pagamento. ' +
      'NÃO confirme pagamento por causa dela. Se o pagamento tinha acabado de ser combinado, peça com gentileza o comprovante; senão, pergunte do que se trata.]'
    );
  }
  const valor = analise.valor != null ? `R$ ${analise.valor.toFixed(2).replace('.', ',')}` : 'não legível';
  const dest =
    [analise.nomeDestinatario, analise.chaveDestino ? `chave ${analise.chaveDestino}` : null]
      .filter(Boolean)
      .join(' — ') || 'não legível';
  const cabeca = `[o paciente enviou uma imagem pelo WhatsApp. Análise automática: COMPROVANTE de pagamento detectado — valor: ${valor}; destinatário: ${dest}${analise.instituicao ? `; instituição: ${analise.instituicao}` : ''}${analise.dataHora ? `; data: ${analise.dataHora}` : ''}.`;
  if (verificacao === 'nao_confere') {
    return (
      `${cabeca} ⚠️ A chave do destinatário NÃO CONFERE com a chave Pix da clínica. NÃO confirme o pagamento e NÃO envie o formulário: ` +
      'diga com gentileza que o comprovante parece ter sido feito para outro destinatário, reenvie a chave correta da clínica e peça pra pessoa verificar.]'
    );
  }
  const chaveNota =
    verificacao === 'confere'
      ? 'A chave do destinatário CONFERE com a da clínica.'
      : 'Não foi possível confirmar a chave do destinatário (a equipe confere manualmente).';
  return (
    `${cabeca} ${chaveNota} Antes de confirmar, confira você se o VALOR acima bate com a opção que o paciente escolheu ` +
    '(individual: avulsa R$ 75,00 / pacote R$ 280,00 / quinzenal R$ 150,00; casal: avulsa R$ 150,00 / pacote R$ 550,00). ' +
    'Se o valor NÃO bater, NÃO confirme e NÃO envie o formulário: aponte a diferença com gentileza e peça pra pessoa verificar o pagamento.]'
  );
}

/** Chave esperada da clínica: PIX_CHAVE (se setada) senão o texto da PIX_INFO. */
export function chaveEsperada(): string {
  return process.env.PIX_CHAVE?.trim() || process.env.PIX_INFO?.trim() || '';
}
