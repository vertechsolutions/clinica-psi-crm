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
  pixEnviado: boolean;
  opcaoEscolhida: boolean;
  /** comprovante ACEITO pela análise automática */
  comprovanteOk: boolean;
  /** comprovante recusado (chave/valor errado) ou imagem que não é comprovante */
  comprovanteRecusado: boolean;
  /** horas entre a última mensagem e a anterior (null quando não dá pra saber) */
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
/** escolha DECIDIDA (não "tem pacote?" nem "qual a diferença de avulsa pra pacote?") */
const OPCAO_DECIDIDA =
  /\b(quero|prefiro|vou (?:de|querer|ficar com)|fico com|escolho|pode ser|melhor)\b[^.!?]{0,30}\b(avulsa|pacote|quinzenal)\b|\b(avulsa|pacote|quinzenal)\b[^.!?]{0,20}\b(mesmo|ent[ãa]o|por favor)\b/i;
const COMPROVANTE_CABECA = /COMPROVANTE de pagamento detectado/i;
/** o marcador de recusa REPETE o cabeçalho, então a recusa tem que ser checada antes */
const COMPROVANTE_RECUSADO =
  /N[ÃA]O CONFERE|N[ÃA]O confirme o pagamento|N[ÃA]O parece ser um comprovante/i;

const algum = (h: MensagemHistorico[], role: 'user' | 'assistant', re: RegExp) =>
  h.some((m) => m.role === role && re.test(m.content));

/** Última modalidade que o PACIENTE afirmou; ignora pergunta e negação. */
function modalidadeDita(hist: MensagemHistorico[]): 'individual' | 'casal' | null {
  for (let i = hist.length - 1; i >= 0; i--) {
    const m = hist[i];
    if (m.role !== 'user') continue;
    const t = m.content;
    const negaCasal = /n[ãa]o (?:é|e|eh|seria|for)\b[^.!?]{0,15}casal/i.test(t);
    const temCasal = /\bcasal\b/i.test(t) && !negaCasal;
    const temIndividual = /\bindividual\b/i.test(t);
    if (temCasal && temIndividual && t.includes('?')) continue; // "individual ou casal?"
    if (temCasal && temIndividual) return 'individual'; // "individual, não de casal"
    if (temCasal) return 'casal';
    if (temIndividual) return 'individual';
  }
  return null;
}

export function extrairSinais(hist: MensagemHistorico[]): SinaisRetomada {
  const n = hist.length;
  const ultima = hist[n - 1]?.at;
  const anterior = hist[n - 2]?.at;
  const horas =
    ultima instanceof Date && anterior instanceof Date
      ? (ultima.getTime() - anterior.getTime()) / 3_600_000
      : null;
  const recusado = hist.some((m) => COMPROVANTE_RECUSADO.test(m.content));
  return {
    valores: algum(hist, 'assistant', VALORES),
    modalidade: modalidadeDita(hist),
    horarioProposto: hist.some(
      (m) => m.role === 'assistant' && DIA_HORA.test(m.content) && OFERTA.test(m.content),
    ),
    pixEnviado: algum(hist, 'assistant', PIX),
    opcaoEscolhida: algum(hist, 'user', OPCAO_DECIDIDA),
    comprovanteOk: !recusado && hist.some((m) => COMPROVANTE_CABECA.test(m.content)),
    comprovanteRecusado: recusado,
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
