// Trava determinística contra "passou tudo de novo" quando o paciente retoma a
// conversa (pedido da Bruna em 27/07/2026, áudio + print). Mesma ideia do
// [DADOS DO CONTATO]: o código lê o histórico, deduz o que já foi tratado e diz
// ao modelo o que NÃO repetir. Funções puras.

export interface MensagemHistorico {
  role: 'user' | 'assistant';
  content: string;
  /** quando foi gravada — usado só pro intervalo da retomada */
  at?: Date | null;
}

export interface SinaisRetomada {
  valores: boolean;
  modalidade: 'individual' | 'casal' | null;
  horarioProposto: boolean;
  /**
   * A Camila propôs um horário concreto E o paciente aceitou DEPOIS disso.
   * Separado do `horarioProposto` porque é a etapa 6 de verdade: propor não
   * agenda ninguém, e é o aceite que libera o pagamento (`pagamento.ts`).
   */
  horarioAceito: boolean;
  pixEnviado: boolean;
  opcaoEscolhida: boolean;
  /** o ÚLTIMO anexo foi lido como comprovante (chave confere/inconclusiva ou análise indisponível) */
  comprovanteOk: boolean;
  /** o ÚLTIMO anexo foi um comprovante RECUSADO (chave do destinatário não confere) */
  comprovanteRecusado: boolean;
  /** o ÚLTIMO anexo não era comprovante (foto qualquer) — sinal separado, NÃO é recusa de pagamento */
  anexoNaoComprovante: boolean;
  /** horas desde a última fala da Camila (null quando não dá pra saber) */
  horasDesdeUltimoContato: number | null;
}

/** A partir daqui a conversa conta como RETOMADA (paciente sumiu e voltou). */
const RETOMADA_HORAS = 6;

const VALORES = /r\$\s?(75|150|280|550)\b/i;
const DIA = String.raw`(?:segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado)`;
// "18h", "18h30", "18 horas", "18:30" — o \b depois do h quebraria em "13h45"
const HORA = String.raw`\d{1,2}\s?(?:h(?:\s?\d{2}|oras?)?|:\s?\d{2})`;
const DIA_HORA = new RegExp(`(?:${DIA}[^.!?]{0,40}?${HORA}|${HORA}[^.!?]{0,25}?${DIA})`, 'i');
/** só conta como PROPOSTA se a Camila estiver oferecendo, não descrevendo o expediente */
const OFERTA = /livre|dispon[íi]vel|reserv|encaix|que tal|posso te (marcar|agendar)|consigo te|agendei|agendado|fica bom|te encaixo/i;
const PIX = /chave\s+pix|pix\s*\(/i;
/**
 * Aceite do horário pelo paciente. Curto de propósito: quem aceita um horário no
 * WhatsApp responde "pode ser", "combinado", "ok" — raramente repete a frase
 * inteira. O que dá precisão não é a regex, é a ORDEM: só conta se vier DEPOIS de
 * uma proposta concreta da Camila.
 */
const ACEITE =
  /\b(pode ser|pode marcar|pode reservar|pode agendar|isso mesmo|esse mesmo|perfeito|fechado|confirmo|combinado|topo|aceito|t[áa] (bom|certo)|ok|beleza|vamos)\b/i;
/** escolha DECIDIDA (não "tem pacote?" nem "qual a diferença de avulsa pra pacote?") */
const OPCAO_DECIDIDA =
  /\b(quero|prefiro|vou (?:de|querer|ficar com)|fico com|escolho|pode ser|melhor)\b[^.!?]{0,30}\b(avulsa|pacote|quinzenal)\b|\b(avulsa|pacote|quinzenal)\b[^.!?]{0,20}\b(mesmo|ent[ãa]o|por favor)\b/i;
/** os 4 marcadores do comprovante-core começam com isto (é o que identifica um anexo) */
const MARCADOR_ANEXO = /^\s*\[o paciente enviou uma imagem/i;
/** marcador de chave errada — REPETE o cabeçalho do comprovante, então é checado antes do "ok" */
const CHAVE_NAO_CONFERE = /N[ÃA]O CONFERE|N[ÃA]O confirme o pagamento/i;
/** marcador de foto qualquer: não é recusa de pagamento, é "do que se trata?" */
const NAO_EH_COMPROVANTE = /N[ÃA]O parece ser um comprovante/i;

type ClasseAnexo = 'comprovante' | 'recusado' | 'nao_comprovante' | null;

/**
 * Classifica SÓ o ÚLTIMO marcador de anexo do histórico. Varrer o histórico
 * inteiro deixava os sinais pegajosos em dois casos reais: (a) o paciente
 * mandava pro Pix errado, refazia certo, e a recusa continuava ligada — a
 * Camila cobrava um pagamento que já tinha entrado; (b) uma foto qualquer
 * ("NÃO parece ser um comprovante") ligava a recusa antes de qualquer pagamento
 * ter sido combinado. Exigir o prefixo do marcador também impede que uma frase
 * da PRÓPRIA Camila ("o valor do comprovante não confere com o que
 * combinamos") ligue o sinal de recusa.
 */
function classificarUltimoAnexo(hist: MensagemHistorico[]): ClasseAnexo {
  for (let i = hist.length - 1; i >= 0; i--) {
    const t = hist[i].content;
    if (!MARCADOR_ANEXO.test(t)) continue;
    // o webhook grava `${marcador} Legenda: ${caption}` — classifica só o marcador,
    // pra legenda do paciente não virar veredito da análise
    const fim = t.indexOf(']');
    const marcador = fim >= 0 ? t.slice(0, fim + 1) : t;
    if (NAO_EH_COMPROVANTE.test(marcador)) return 'nao_comprovante';
    if (CHAVE_NAO_CONFERE.test(marcador)) return 'recusado';
    // sobram chave confere/inconclusiva e "análise indisponível" — nos dois o
    // marcador manda tratar como comprovante e seguir o fluxo normal
    return 'comprovante';
  }
  return null;
}

/** Quando a Camila falou pela última vez (null se nenhuma mensagem dela tem data). */
function ultimaFalaDoAssistente(hist: MensagemHistorico[]): Date | null {
  for (let i = hist.length - 1; i >= 0; i--) {
    const m = hist[i];
    if (m.role === 'assistant' && m.at instanceof Date) return m.at;
  }
  return null;
}

const algum = (h: MensagemHistorico[], role: 'user' | 'assistant', re: RegExp) =>
  h.some((m) => m.role === role && re.test(m.content));

/** Última modalidade que o PACIENTE afirmou; ignora pergunta e negação. */
function modalidadeDita(hist: MensagemHistorico[]): 'individual' | 'casal' | null {
  for (let i = hist.length - 1; i >= 0; i--) {
    const m = hist[i];
    if (m.role !== 'user') continue;
    const t = m.content;
    // \s em vez de \b depois do verbo: "é" não é \w, então "não é de casal" nunca
    // casava com \b e a negação passava batido (a pessoa dizia "não é casal" e a
    // ficha marcava casal). A vírgula de "não, é casal" continua bloqueando o match.
    const negaCasal = /n[ãa]o (?:é|e|eh|seria|for)\s[^.!?]{0,15}casal/i.test(t);
    const temCasal = /\bcasal\b/i.test(t) && !negaCasal;
    const temIndividual = /\bindividual\b/i.test(t);
    if (temCasal && temIndividual && t.includes('?')) continue; // "individual ou casal?"
    if (temCasal && temIndividual) return 'individual'; // "individual, não de casal"
    if (temCasal) return 'casal';
    if (temIndividual) return 'individual';
  }
  return null;
}

/**
 * Houve proposta concreta de horário e, DEPOIS dela, um aceite do paciente?
 *
 * A ordem é a substância da função. Um "pode ser" solto no começo da conversa
 * (respondendo "prefere individual ou casal?", por exemplo) não agenda nada — e
 * tratá-lo como aceite liberaria justamente o pagamento adiantado que o
 * `pagamento.ts` existe para impedir.
 */
function horarioFoiAceito(hist: MensagemHistorico[]): boolean {
  const propostaEm = hist.findIndex(
    (m) => m.role === 'assistant' && DIA_HORA.test(m.content) && OFERTA.test(m.content),
  );
  if (propostaEm < 0) return false;
  return hist
    .slice(propostaEm + 1)
    .some((m) => m.role === 'user' && (ACEITE.test(m.content) || DIA_HORA.test(m.content)));
}

export function extrairSinais(hist: MensagemHistorico[]): SinaisRetomada {
  const n = hist.length;
  const ultima = hist[n - 1]?.at;
  // gap contado desde a última fala da CAMILA, não desde a mensagem anterior: quem
  // volta depois de 3 dias costuma mandar "bom dia" e, 10 segundos depois, "gostaria
  // de agendar" — medindo só as duas últimas, o segundo turno dava segundos e perdia
  // o [ONDE PARAMOS] (justamente o caso do áudio da Bruna).
  const falouEm = ultimaFalaDoAssistente(hist);
  const horas =
    ultima instanceof Date && falouEm ? (ultima.getTime() - falouEm.getTime()) / 3_600_000 : null;
  const anexo = classificarUltimoAnexo(hist);
  return {
    valores: algum(hist, 'assistant', VALORES),
    modalidade: modalidadeDita(hist),
    horarioProposto: hist.some(
      (m) => m.role === 'assistant' && DIA_HORA.test(m.content) && OFERTA.test(m.content),
    ),
    horarioAceito: horarioFoiAceito(hist),
    pixEnviado: algum(hist, 'assistant', PIX),
    opcaoEscolhida: algum(hist, 'user', OPCAO_DECIDIDA),
    comprovanteOk: anexo === 'comprovante',
    comprovanteRecusado: anexo === 'recusado',
    anexoNaoComprovante: anexo === 'nao_comprovante',
    horasDesdeUltimoContato: horas,
  };
}

export interface EtapaOpts {
  /** o [DADOS DO CONTATO] já resolveu o primeiro nome? */
  temNome?: boolean;
}

/**
 * Próxima etapa pendente, olhando o funil de trás pra frente. NUNCA manda
 * confirmar pagamento: quem decide isso é o marcador da análise do comprovante
 * (que pode ser de recusa) e o backstop do webhook.
 */
export function proximaEtapa(s: SinaisRetomada, opts: EtapaOpts = {}): string {
  if (s.comprovanteRecusado)
    return 'o último comprovante NÃO foi aceito — siga o que o marcador da análise manda: peça o pagamento para a chave correta da clínica, sem confirmar nada';
  if (s.comprovanteOk) return 'conferir o comprovante recebido e seguir exatamente o que o marcador da análise manda';
  // foto que NÃO é comprovante nunca vira cobrança: se o Pix já foi enviado dá pra
  // pedir o comprovante, senão a pessoa só mandou uma imagem qualquer (print, foto,
  // documento) e o funil segue de onde estava — pedir pagamento aqui era o caso em
  // que a Camila cobrava um Pix que nunca tinha sido combinado.
  if (s.anexoNaoComprovante && s.pixEnviado)
    return 'a última imagem NÃO era um comprovante — pergunte com gentileza do que se trata e peça o comprovante do Pix que já foi enviado, sem cobrar o pagamento de novo';
  if ((s.opcaoEscolhida || s.pixEnviado) && s.horarioProposto) return 'receber o comprovante do pagamento';
  if (s.horarioProposto) return 'confirmar o horário e perguntar se prefere avulsa ou pacote';
  if (s.valores && !opts.temNome) return 'perguntar como pode chamar a pessoa (só o primeiro nome)';
  if (s.valores) return 'entender o que a trouxe e a disponibilidade, e propor um horário concreto';
  if (s.modalidade) return 'passar os valores da modalidade';
  return 'seguir o funil normalmente';
}

/** Frase do intervalo (só é chamada quando já houve gap de 6h+). */
function trechoIntervalo(horas: number): string {
  if (horas < 24) return ' — a pessoa voltou algumas horas depois';
  const dias = Math.round(horas / 24);
  return ` — a pessoa voltou depois de ${dias} ${dias === 1 ? 'dia' : 'dias'}`;
}

function listaTratados(s: SinaisRetomada): string[] {
  const t: string[] = [];
  if (s.modalidade) t.push(`modalidade (${s.modalidade})`);
  if (s.valores) t.push('valores das sessões');
  if (s.horarioProposto) t.push('proposta de horário');
  if (s.pixEnviado) t.push('dados do Pix');
  if (s.opcaoEscolhida) t.push('escolha entre avulsa e pacote');
  if (s.comprovanteOk) t.push('comprovante enviado');
  if (s.comprovanteRecusado) t.push('comprovante enviado mas NÃO aceito');
  return t;
}

/**
 * Bloco pro system prompt. Vazio em primeiro contato. Com gap curto sai a versão
 * factual ([JÁ TRATADO]); com 6h+ sai a de retomada ([ONDE PARAMOS]), que é a
 * única que fala em saudação — mandar cumprimentar a cada turno brigaria com a
 * regra de variação do prompt.
 */
export function blocoOndeParamos(hist: MensagemHistorico[], opts: EtapaOpts = {}): string {
  if (hist.length < 2) return '';
  const s = extrairSinais(hist);
  const tratados = listaTratados(s);
  if (tratados.length === 0) return '';
  const etapa = proximaEtapa(s, opts);
  const rodape =
    'Este resumo é derivado automaticamente do histórico: se o histórico contradisser alguma linha daqui, o HISTÓRICO vence.';
  const horas = s.horasDesdeUltimoContato;

  if (horas == null || horas < RETOMADA_HORAS) {
    return `[JÁ TRATADO NESTA CONVERSA]
${tratados.join('; ')}.
Não repita isso por iniciativa própria — se a pessoa PEDIR de novo (valor, chave Pix, horário, link), aí sim reenvie normalmente.
Próxima etapa pendente: ${etapa}.
${rodape}`;
  }

  return `[ONDE PARAMOS]
Esta conversa NÃO é um primeiro contato${trechoIntervalo(horas)}. NUNCA reabra com boas-vindas ("Seja bem-vindo(a) à Cazule. Me chamo Camila...").
Já tratado: ${tratados.join('; ')}.
Não repita isso por iniciativa própria — se a pessoa PEDIR de novo, reenvie normalmente.
Próxima etapa pendente: ${etapa}. Cumprimente em UMA frase curta (pelo nome, se souber) e siga direto por ela.
${rodape}`;
}
