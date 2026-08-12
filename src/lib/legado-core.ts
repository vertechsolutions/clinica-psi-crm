/**
 * Núcleo puro da lista de LEGADO — as conversas que já eram atendidas à mão pela
 * Bruna quando a Camila entrou no número profissional dela. Sem rede, sem banco:
 * dá pra testar tudo aqui com `scripts/test-legado.ts`.
 *
 * Por que hash e não o telefone: a lista tem centenas de números de gente que
 * NUNCA pediu triagem (pacientes dela, família, fornecedor). Guardar isso em claro
 * seria montar a agenda de contatos da Bruna num banco operado por terceiro. Como
 * a tabela só faz igualdade exata, o hash não custa nada em funcionalidade.
 *
 * HMAC e não sha256 puro: celular brasileiro tem ~2³³ combinações, então um sha256
 * sem chave se quebra por força bruta em segundos. A chave mora em env, nunca no
 * banco — quem tiver um dump não tem a lista.
 */
import crypto from 'node:crypto';

/**
 * De onde veio a supressão. `pausada` é a mais nova (11/08/2026): a retenção
 * apaga a linha de `wa_conversations` em 30/90 dias, e com ela a flag `pausada`
 * — o que devolvia à Camila, em silêncio, um chat que a Bruna tinha assumido.
 * A decisão de não falar migra pra cá antes do conteúdo sumir.
 */
export type OrigemLegado = 'snapshot' | 'contato' | 'eco' | 'manual' | 'pausada';

/** Só dígitos (mesma normalização do transporte). */
const digitos = (s: string): string => (s || '').replace(/\D/g, '');

/**
 * As formas em que o MESMO humano pode aparecer.
 *
 * O WhatsApp brasileiro carrega dois formatos do mesmo celular: com e sem o 9º
 * dígito. Não é hipótese — no aparelho da Bruna, 64 dos 720 chats vêm com 12
 * dígitos. Se o `/chats` devolver `554988887777` e o webhook entregar
 * `5549988887777`, o SELECT não acha e a Camila responde uma paciente de legado,
 * que é justamente o erro caro.
 *
 * Guardamos as duas formas e consultamos as duas. O falso positivo possível (um
 * telefone FIXO que coincida com a variante de um celular) erra na direção segura:
 * a IA cala, e a Bruna atende como sempre atendeu.
 */
export function chavesEquivalentes(waId: string): string[] {
  const n = digitos(waId);
  if (!n) return [];
  const out = new Set<string>([n]);

  if (n.startsWith('55')) {
    const ddd = n.slice(2, 4);
    const local = n.slice(4);
    // 55 + DD + 9XXXXXXXX  →  também sem o 9
    if (local.length === 9 && local.startsWith('9')) out.add(`55${ddd}${local.slice(1)}`);
    // 55 + DD + NXXXXXXX (celular antigo, N de 6 a 9)  →  também com o 9
    if (local.length === 8 && /^[6-9]/.test(local)) out.add(`55${ddd}9${local}`);
  }
  return [...out];
}

/** HMAC-SHA256(chave, waId) em hex. */
export function hashChave(waId: string, chave: string): string {
  return crypto.createHmac('sha256', chave).update(digitos(waId)).digest('hex');
}

/** Todas as variantes já hasheadas — é o que se grava e o que se consulta. */
export function hashesDe(waId: string, chave: string): string[] {
  return chavesEquivalentes(waId).map((v) => hashChave(v, chave));
}

/**
 * Hash de um LID. Namespace separado do telefone de propósito: um LID é só uma
 * sequência longa de dígitos, e sem o prefixo um LID que por acaso coincidisse
 * com um telefone calaria a pessoa errada.
 */
export function hashLid(lid: string, chave: string): string {
  return crypto.createHmac('sha256', chave).update(`lid:${digitos(lid)}`).digest('hex');
}

/**
 * Impressão digital da chave, gravada junto do snapshot. O gate compara antes de
 * confiar na tabela: se alguém trocar a `WA_LEGADO_CHAVE`, os hashes viram lixo e
 * a lista inteira deixaria de casar — sem isso, o efeito seria a Camila voltar a
 * falar em TODAS as conversas manuais, em silêncio. Com isso, ela cala e alguém
 * descobre. Não expõe a chave: é o digest, não a chave.
 */
export function impressaoDigital(chave: string): string {
  return crypto.createHash('sha256').update(chave).digest('hex').slice(0, 16);
}

/**
 * Números que NUNCA entram na lista e NUNCA são calados: a equipe. Sem isso o
 * snapshot marcaria a Bruna e o Murilo como legado (eles obviamente já conversam
 * com esse celular) e a Camila ficaria muda justo pra quem precisa testá-la.
 *
 * Sai de `NOTIFY_ALERT_NUMBERS` e SÓ dela, de propósito: é a lista que define
 * "quem é a equipe" e não muda no rollout. Somar a `WA_ALLOWLIST` faria o conjunto
 * protegido encolher no dia em que ela for esvaziada — o desenho ficaria correto
 * por coincidência (hoje as duas envs têm os mesmos números) em vez de por
 * construção.
 */
export function protegidos(env: NodeJS.ProcessEnv): string[] {
  return [
    ...new Set(
      (env.NOTIFY_ALERT_NUMBERS || '')
        .split(',')
        .map((s) => digitos(s))
        .filter(Boolean),
    ),
  ];
}

/** true se o número é da equipe (compara também as variantes de 9º dígito). */
export function ehProtegido(waId: string, env: NodeJS.ProcessEnv): boolean {
  const lista = protegidos(env);
  if (lista.length === 0) return false;
  return chavesEquivalentes(waId).some((v) => lista.includes(v));
}

/** O mínimo que a coleta precisa expor — `name` e `notes` nunca chegam aqui. */
export interface ChatMinimo {
  phone: string;
  /** identificador anônimo, quando o contato oculta o número (só dígitos) */
  lid?: string;
  isGroup: boolean;
}

export interface IdentificadoresDoLegado {
  /** telefones (viram hash com as duas grafias do 9º dígito) */
  telefones: string[];
  /** LIDs de contatos com número oculto (hash direto — não é telefone) */
  lids: string[];
  grupos: number;
  /** nem telefone nem lid utilizável */
  invalidos: number;
  protegidos: number;
  /** quantos entraram SÓ pelo lid (não tinham telefone) */
  somenteLid: number;
}

/** Um LID é uma sequência longa de dígitos — não tem DDI, DDD nem 9º dígito. */
const lidValido = (s: string): boolean => s.length >= 10 && s.length <= 25;

/**
 * O que de uma coleta deve virar linha na lista, separado por tipo de
 * identificador. Descarta grupo e a equipe.
 *
 * O `lid` importa mais do que parece: no aparelho da Bruna, **mais da metade** das
 * conversas vem sem `phone`, só com `lid` — é o contato que ligou a privacidade de
 * número. Ignorá-los deixaria metade dos pacientes antigos desprotegidos.
 */
export function identificadoresParaLegado(
  chats: ChatMinimo[],
  env: NodeJS.ProcessEnv,
): IdentificadoresDoLegado {
  const lista = protegidos(env);
  const telefones = new Set<string>();
  const lids = new Set<string>();
  let grupos = 0;
  let invalidos = 0;
  let daEquipe = 0;
  let somenteLid = 0;

  for (const c of chats) {
    if (c.isGroup) {
      grupos++;
      continue;
    }
    const n = digitos(c.phone);
    const l = digitos(c.lid ?? '');
    const temTelefone = n.length >= 10 && n.length <= 15;

    // a equipe é reconhecida pelo telefone; sem ele não há como saber que é ela,
    // mas também não há risco — a equipe não conversa com a clínica por número oculto
    if (temTelefone && lista.length && chavesEquivalentes(n).some((v) => lista.includes(v))) {
      daEquipe++;
      continue;
    }

    let entrou = false;
    if (temTelefone) {
      telefones.add(n);
      entrou = true;
    }
    // guarda o lid TAMBÉM quando há telefone: a mesma pessoa pode chegar de um
    // jeito no import e de outro no webhook
    if (lidValido(l)) {
      lids.add(l);
      if (!temTelefone) somenteLid++;
      entrou = true;
    }
    if (!entrou) invalidos++;
  }
  return {
    telefones: [...telefones],
    lids: [...lids],
    grupos,
    invalidos,
    protegidos: daEquipe,
    somenteLid,
  };
}
