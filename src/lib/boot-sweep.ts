/**
 * Varredura de pendentes no boot — a rede de segurança do debounce.
 *
 * O turno por rajada (`turno.ts`) só responde depois de 8s de silêncio. Se o
 * processo reiniciar DENTRO dessa janela — deploy, OOM, restart do Railway — a
 * mensagem do lead já está gravada em `wa_messages`, mas o timer morreu junto
 * com o processo e nada mais a reprocessa: o webhook já devolveu 200, então o
 * provider não reentrega. O lead fica falando sozinho e ninguém percebe.
 *
 * De quebra fecha uma limitação que já existia ANTES desta leva e está
 * declarada no `route.ts`: o crash no meio do `after()`.
 *
 * O que esta varredura NÃO faz: análise de anexo fresca. Um turno que era de
 * comprovante volta por aqui sem o veredito da imagem, então o backstop de
 * comprovante não protege este caminho. Limitação aceita no desenho — o alerta
 * de equipe cobre com "recebido em turno anterior — conferir na conversa".
 */
import { query } from './db';
import { atende } from './allowlist';
import { deveIgnorarPorLegado } from './legado';

/** LGPD: log nunca leva o telefone inteiro — só os 4 últimos, pra diagnóstico. */
const mascarar = (waId: string) => `***${waId.slice(-4)}`;

/**
 * Idade máxima da mensagem que ainda vale a pena responder.
 *
 * Mais velho que isso e a resposta chega fora de hora: ou a pessoa desistiu, ou
 * a Bruna já respondeu à mão pelo celular — e uma Camila que acorda meia hora
 * depois falando por cima é pior do que o silêncio que ela veio consertar. 30
 * minutos cobre com folga o pior restart (deploy do Railway leva ~1 min).
 */
const JANELA_MINUTOS = 30;

/**
 * Teto de números por varredura. NÃO é parâmetro de negócio: é raio de
 * explosão. Numa clínica pequena a fila real cabe nos dedos de uma mão, e se
 * algum dia a consulta devolver dezenas de números, a causa provável é um bug
 * (persistência de resposta quebrada faz TODA conversa parecer pendente) — e aí
 * o teto é a diferença entre 50 mensagens indevidas e o banco inteiro. Quem
 * ficar de fora aparece no log e volta na próxima subida.
 */
const TETO_POR_VARREDURA = 50;

/**
 * O que é "conversa pendente", em SQL: a última mensagem do lead é mais nova
 * que a última resposta da Camila (ou não existe resposta nenhuma), e chegou
 * dentro da janela.
 *
 * `'-infinity'` no COALESCE é o que faz o caso mais grave entrar — a conversa
 * que nunca teve resposta, ou seja, o lead que escreveu pela primeira vez e
 * cujo processo morreu antes de a Camila abrir a boca.
 *
 * Vive numa constante só porque a lista do boot e a reconferência por número
 * PRECISAM ser a mesma pergunta: se as duas divergirem, a segunda vira um filtro
 * silencioso que descarta gente sem ninguém entender por quê.
 */
const PENDENTE = `
       max(m.created_at) FILTER (WHERE m.role = 'user')
         > COALESCE(max(m.created_at) FILTER (WHERE m.role = 'assistant'), '-infinity'::timestamptz)
   AND max(m.created_at) FILTER (WHERE m.role = 'user') > now() - interval '${JANELA_MINUTOS} minutes'`;

/** Assinatura de `processarTurnoPendente` — injetável só para o teste. */
export type ProcessarTurno = (waId: string, nome?: string) => Promise<void>;

interface Pendente {
  waId: string;
  nome?: string;
}

/**
 * Os números que ficaram sem resposta.
 *
 * Parte de `wa_messages` com LEFT JOIN, e não de `wa_conversations`: a linha da
 * conversa só nasce no `persistReply` (ou no claim), então partir dela perderia
 * exatamente o lead novo — o caso que mais dói.
 *
 * Ordena pelo mais ANTIGO primeiro: quem esperou mais é atendido antes, e o
 * teto, quando morde, morde a ponta mais fresca (que ainda pode voltar a
 * escrever e ser atendida pelo webhook ao vivo).
 */
async function listarPendentes(): Promise<{ lista: Pendente[]; truncada: boolean }> {
  const { rows } = await query<{ wa_id: string; nome: string | null }>(
    `SELECT m.wa_id, max(c.nome) AS nome
       FROM wa_messages m
       LEFT JOIN wa_conversations c ON c.wa_id = m.wa_id
      WHERE COALESCE(c.pausada, FALSE) = FALSE
      GROUP BY m.wa_id
     HAVING ${PENDENTE}
      ORDER BY max(m.created_at) FILTER (WHERE m.role = 'user')
      LIMIT ${TETO_POR_VARREDURA + 1}`,
  );
  const truncada = rows.length > TETO_POR_VARREDURA;
  return {
    lista: rows.slice(0, TETO_POR_VARREDURA).map((r) => ({ waId: r.wa_id, nome: r.nome ?? undefined })),
    truncada,
  };
}

/**
 * A mesma pergunta, para UM número, imediatamente antes de reprocessá-lo.
 *
 * Não é zelo: a varredura é sequencial e cada turno custa dezenas de segundos de
 * Gemini, então o último número da fila só é tocado minutos depois de a lista
 * ter sido montada. Nesse intervalo o webhook ao vivo pode ter atendido o lead
 * (ele escreveu de novo) — e responder de novo aqui seria a segunda bolha que
 * esta leva inteira existe para matar. Cobre também o container antigo que
 * ainda estava drenando quando este subiu.
 */
async function continuaPendente(waId: string): Promise<boolean> {
  const { rows } = await query(
    `SELECT 1
       FROM wa_messages m
       LEFT JOIN wa_conversations c ON c.wa_id = m.wa_id
      WHERE m.wa_id = $1 AND COALESCE(c.pausada, FALSE) = FALSE
      GROUP BY m.wa_id
     HAVING ${PENDENTE}`,
    [waId],
  );
  return rows.length === 1;
}

/**
 * Solta os claims EXPIRADOS. Só eles, e o `AND turno_ate < now()` é a linha mais
 * importante deste arquivo.
 *
 * `turno_ate` no futuro é turno VIVO, e apagá-lo mata o turno: o `aindaTitular`
 * do `turno.ts` é checado imediatamente antes do primeiro byte e falha fechado
 * de propósito, então o turno que perdeu o token aborta o envio em silêncio e o
 * lead não recebe nada. Não é hipótese — a primeira versão deste arquivo zerava
 * todo claim no boot e o `test-turno-concorrencia` pegou: "esperava 1 resposta,
 * veio 0".
 *
 * E não é o vizinho de deploy que corre esse risco: é o PRÓPRIO processo. A
 * varredura é fire-and-forget de propósito (não pode segurar o health check), o
 * que significa que ela roda com o servidor JÁ aceitando tráfego — um turno que
 * pegou o claim nesse intervalo teria o token apagado no meio do `computeReply`.
 * A premissa "um boot novo não herda turno em andamento" era falsa exatamente
 * por causa disso.
 *
 * Claim expirado, ao contrário, é de processo morto por definição: o
 * `claimTurno` já o trata como reivindicável, então soltá-lo aqui é higiene, não
 * corrida.
 *
 * RESÍDUO ACEITO, dito na cara: um processo que morreu 5s atrás deixa o claim
 * válido por mais ~85s. A varredura vai desistir em silêncio naquele número, e
 * ele fica sem resposta até o lead escrever de novo ou até o próximo boot. É o
 * comportamento que o `TURNO_TTL_SEGUNDOS` já foi desenhado para governar
 * ("só existe para que um claim de um processo que morreu no meio do turno volte
 * a ser reivindicável"). Uma segunda passada da varredura depois do TTL
 * fecharia essa janela, e é escopo novo — não está implementado.
 *
 * O UPDATE não encosta em `updated_at` de propósito, pelo mesmo motivo listado
 * no `turno-claim.ts`: aquela coluna é o relógio do follow-up, da retenção LGPD
 * e da ordenação do painel.
 */
async function soltarClaimsExpirados(): Promise<number> {
  const r = await query(
    `UPDATE wa_conversations
        SET turno_ate = NULL, turno_token = NULL
      WHERE turno_ate IS NOT NULL AND turno_ate < now()`,
  );
  const n = r.rowCount ?? 0;
  if (n > 0) console.log(`[varredura] ${n} claim(s) de turno expirado(s) liberado(s).`);
  return n;
}

/**
 * Um número: aplica o MESMO gate do webhook ao vivo e manda reprocessar.
 *
 * A ordem é a do `route.ts` de propósito — allowlist antes do legado. Se a
 * varredura respondesse alguém que o webhook calaria, ela furaria a rede de
 * segurança do legado, que é o que impede a Camila de falar em cima de uma
 * conversa humana em andamento da Bruna. É o risco mais sério deste arquivo.
 *
 * Sem `lid` aqui: o webhook o recebe no payload e nós só temos o número. Na
 * prática não afrouxa nada — quem chegou até `wa_messages` já passou pelo gate
 * completo uma vez, e o que a lista de legado ganhou desde então é reavaliado
 * pelo telefone.
 *
 * Nunca lança: um número problemático não pode interromper a fila dos outros.
 */
async function reprocessar(p: Pendente, rodar: ProcessarTurno): Promise<boolean> {
  try {
    if (!atende(p.waId)) {
      console.log(`[varredura] ${mascarar(p.waId)} fora da WA_ALLOWLIST — ignorado.`);
      return false;
    }
    const silencio = await deveIgnorarPorLegado(p.waId);
    if (silencio) {
      console.log(`[varredura] IA silenciosa em ${mascarar(p.waId)} — motivo: ${silencio}.`);
      return false;
    }
    if (!(await continuaPendente(p.waId))) {
      console.log(`[varredura] ${mascarar(p.waId)} já foi respondido enquanto a fila andava — pulado.`);
      return false;
    }
    console.log(`[varredura] reprocessando o turno pendente de ${mascarar(p.waId)}.`);
    await rodar(p.waId, p.nome);
    return true;
  } catch (err) {
    console.error(`[varredura] ${mascarar(p.waId)} falhou — seguindo para o próximo`, err);
    return false;
  }
}

/**
 * A varredura. Devolve quantas conversas foram MANDADAS reprocessar (o desfecho
 * de cada uma é do `processarTurnoPendente`, que desiste em silêncio quando o
 * claim é de outro turno).
 *
 * SEQUENCIAL de propósito: roda no boot, junto com o health check do Railway, e
 * uma rajada paralela de chamadas ao Gemini bem na subida é o jeito mais fácil
 * de derrubar o container que a gente acabou de levantar.
 *
 * NUNCA lança para fora. É chamada fire-and-forget no `instrumentation-node`, e
 * uma promise rejeitada sem handler derruba o processo no Node moderno — ou
 * seja, um erro aqui tiraria o app do ar em vez de deixar uma mensagem sem
 * resposta.
 *
 * `processar` só existe para o teste injetar um espião: o gate (allowlist,
 * legado, pausa, janela) é o que precisa de prova, e exercitá-lo não pode
 * custar uma chamada real ao Gemini por cenário.
 */
export async function varrerPendentes(processar?: ProcessarTurno): Promise<number> {
  try {
    await soltarClaimsExpirados();
    const { lista, truncada } = await listarPendentes();
    if (lista.length === 0) return 0;
    if (truncada) {
      console.warn(
        `[varredura] mais de ${TETO_POR_VARREDURA} conversas pendentes — atendendo as ${TETO_POR_VARREDURA} mais antigas. ` +
          'Volume assim quase sempre é bug de persistência, não fila real: confira antes de subir o teto.',
      );
    }
    console.log(`[varredura] ${lista.length} conversa(s) sem resposta desde o boot anterior.`);

    // Import tardio: sem pendente nenhum (o caso normal) o boot não paga o grafo
    // do turno inteiro — Gemini, provider de WhatsApp, planilha.
    const rodar = processar ?? (await import('./turno')).processarTurnoPendente;

    let reprocessados = 0;
    for (const p of lista) {
      if (await reprocessar(p, rodar)) reprocessados++;
    }
    console.log(`[varredura] concluída: ${reprocessados} de ${lista.length} conversa(s) reprocessada(s).`);
    return reprocessados;
  } catch (err) {
    console.error('[varredura] falhou por inteiro — nenhum pendente reprocessado', err);
    return 0;
  }
}
