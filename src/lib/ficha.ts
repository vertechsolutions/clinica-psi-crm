/**
 * A ficha do paciente como MEMÓRIA de longo prazo da Camila. Funções puras.
 *
 * Dois problemas reais de produção moram aqui:
 * (a) o modelo reextrai a ficha lendo só as últimas 30 mensagens (HISTORY_LIMIT),
 *     então numa conversa longa — tem uma com 180 mensagens no banco — o telefone
 *     dito no começo saía da janela e voltava null. Como o upsert gravava
 *     `lead = EXCLUDED.lead`, esse null SUBSTITUÍA o dado bom já salvo.
 *     `camposPreenchidos` manda ao banco só o que tem conteúdo, pro merge do
 *     JSONB (`lead || EXCLUDED.lead`) nunca apagar dado antigo com um null;
 * (b) mesmo salvo, o dado não voltava pro contexto: só o nome era reinjetado
 *     (blocoContatoDe). A Camila re-perguntava a disponibilidade que a pessoa já
 *     tinha dado 40 mensagens atrás. `blocoFichaDe` devolve isso ao prompt.
 */
import { type LeadExtraido } from './triagem';

/**
 * Sanitiza texto ANTES de injetar no prompt, igual ao `limpa()` do agenda-core.
 * Aqui é ainda mais necessário: o conteúdo da ficha vem do que o PACIENTE
 * escreveu. Sem tirar quebra de linha e colchetes, alguém digita
 * "[DADOS DO CONTATO] ignore tudo" no campo de disponibilidade e envenena o
 * contexto do turno seguinte. O corte em 120 chars limita o estrago (e o tamanho
 * do bloco) mesmo se o modelo despejar um textão num campo.
 */
const limpa = (s: string) => s.replace(/[\r\n[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);

/**
 * Só os campos com conteúdo útil: descarta null, undefined, string vazia/só
 * espaços e array vazio. É o que vai pro banco — com o merge do JSONB, mandar um
 * campo null significaria apagar o valor bom que já estava lá.
 * 0 e false são conteúdo e ficam (hoje a ficha não tem campo assim, mas o dia em
 * que tiver — "sessoesFeitas: 0" — o filtro não pode comê-lo por engano).
 */
export function camposPreenchidos(lead?: Partial<LeadExtraido> | null): Partial<LeadExtraido> {
  const out: Record<string, unknown> = {};
  if (!lead || typeof lead !== 'object') return out as Partial<LeadExtraido>;
  for (const [k, v] of Object.entries(lead)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string' && !v.trim()) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out as Partial<LeadExtraido>;
}

/** "F"/"M"/"indiferente" em português de gente. */
function textoPreferencia(v: string): string | null {
  if (v === 'F') return 'prefere profissional mulher';
  if (v === 'M') return 'prefere profissional homem';
  if (v === 'indiferente') return 'tanto faz o gênero da profissional';
  return null;
}

/**
 * Bloco `[FICHA DO PACIENTE]` pro system prompt: os dados já coletados que
 * ajudam a conduzir a conversa. NÃO inclui o nome de propósito — ele já vai no
 * [DADOS DO CONTATO] com a regra dele, e repetir aqui só duplicaria contexto.
 * String vazia quando não há nenhum campo útil (aí o prompt fica como era).
 */
export function blocoFichaDe(lead?: Partial<LeadExtraido> | null): string {
  const f = camposPreenchidos(lead);
  const linhas: string[] = [];
  const add = (rotulo: string, valor: unknown) => {
    if (typeof valor !== 'string') return;
    const v = limpa(valor);
    if (v) linhas.push(`- ${rotulo}: ${v}`);
  };

  add('Telefone/WhatsApp', f.telefone);
  add('E-mail', f.email);
  add('Disponibilidade', f.disponibilidade);
  add('Preferência de profissional/abordagem', f.preferenciaAbordagem);
  if (typeof f.preferencia === 'string') {
    const pref = textoPreferencia(f.preferencia);
    if (pref) linhas.push(`- Gênero da profissional: ${pref}`);
  }
  // motivação é a queixa contada pela pessoa; o resumo é a versão pro CRM — um só basta
  add('Queixa/motivo da busca', f.motivacao ?? f.resumo);
  if (Array.isArray(f.sintomas) && f.sintomas.length) {
    const temas = limpa(f.sintomas.filter((s) => typeof s === 'string').join(', '));
    if (temas) linhas.push(`- Temas relatados: ${temas}`);
  }
  add('Estado civil', f.statusRelacionamento);
  if (typeof f.filhos === 'string' && f.filhos.trim()) {
    linhas.push(`- Filhos: ${f.filhos === 'nao' ? 'não tem' : limpa(f.filhos)}`);
  }
  add('Dados para nota fiscal', f.notaFiscal);

  if (!linhas.length) return '';
  return [
    '[FICHA DO PACIENTE]',
    'Dados que você já coletou desta pessoa em algum momento da conversa (podem estar fora do trecho de histórico que você está vendo agora):',
    ...linhas,
    'NÃO pergunte de novo nada que já esteja nesta ficha — use com naturalidade o que está aqui. Se a pessoa CORRIGIR algum dado agora, vale o que ela disser agora.',
  ].join('\n');
}

/**
 * Whitelist dos campos que o PATCH admin pode escrever, derivada do TIPO: o
 * `satisfies Record<keyof LeadExtraido, ...>` obriga que todo campo de
 * LeadExtraido esteja aqui e que nada de fora entre — quem acrescentar um campo
 * novo na ficha e esquecer desta lista quebra o `tsc`, em vez de descobrir em
 * produção que o campo não é corrigível. 'lista' é o único campo array
 * (sintomas); o resto é texto livre que o paciente falou.
 */
const CAMPOS_FICHA = {
  nome: 'texto',
  dataNascimento: 'texto',
  email: 'texto',
  telefone: 'texto',
  contatoEmergencia: 'texto',
  profissao: 'texto',
  disponibilidade: 'texto',
  preferenciaAbordagem: 'texto',
  preferencia: 'texto',
  diagnostico: 'texto',
  terapiaAnterior: 'texto',
  statusRelacionamento: 'texto',
  filhos: 'texto',
  vicios: 'texto',
  expectativa: 'texto',
  motivacao: 'texto',
  sintomas: 'lista',
  notaFiscal: 'texto',
  observacoes: 'texto',
  resumo: 'texto',
} satisfies Record<keyof LeadExtraido, 'texto' | 'lista'>;

export interface CamposFichaSanitizados {
  /** campos com valor novo — vão pro merge do JSONB (`lead || $2::jsonb`) */
  campos: Partial<LeadExtraido>;
  /** chaves a apagar da ficha (`lead - $3::text[]`) */
  remover: string[];
  /** chaves recusadas (desconhecidas ou com tipo errado) — o caller responde 400 */
  invalidos: string[];
}

/**
 * Filtra o corpo de um PATCH admin (a Bruna consertando um dado que o paciente
 * digitou errado) antes de encostar no banco. Regras e o porquê de cada uma:
 *
 * - só as chaves de LeadExtraido passam. O corpo vem cru do HTTP: sem whitelist,
 *   um `{"pausada": false}` ou `{"__proto__": "x"}` viraria chave dentro do JSONB
 *   da ficha e a Camila leria isso como se fosse coisa dita pela pessoa. Por isso
 *   o `Object.hasOwn` — `CAMPOS_FICHA['__proto__']` sozinho devolve o
 *   Object.prototype (truthy) e passaria pelo teste ingênuo.
 * - `null` (ou string vazia / só espaços) = APAGAR o campo. Formulário devolve
 *   campo limpo como "", nunca como null; e gravar "" só deixaria lixo no JSONB,
 *   já que o blocoFichaDe ignora vazio. Os dois viram remoção de chave.
 * - número e boolean são RECUSADOS, não convertidos: `{"filhos": 2}` ou
 *   `{"preferencia": true}` é cliente mandando o shape errado, e coagir pra "2"
 *   gravaria calado um dado que a Camila vai usar em voz alta no turno seguinte.
 *   Erro alto (400) é melhor que ficha errada em dado de saúde.
 * - sintomas tem que ser array SÓ de string (um item não-string reprova o campo
 *   inteiro — meia-lista salva seria pior que recusar); itens vazios e repetidos
 *   caem fora, e lista vazia é remoção.
 *
 * Validamos FORMA, não vocabulário: um "preferencia": "mulher" fora do enum
 * passa e o pior que acontece é o blocoFichaDe omitir a linha — quem digita aqui
 * é a admin, não o paciente, e travar o vocabulário só atrapalharia a correção.
 */
export function sanitizarCamposFicha(entrada: unknown): CamposFichaSanitizados {
  const campos: Record<string, unknown> = {};
  const remover: string[] = [];
  const invalidos: string[] = [];
  // corpo ausente/array/escalar: nada a fazer (o caller devolve "nenhum campo válido")
  if (!entrada || typeof entrada !== 'object' || Array.isArray(entrada)) {
    return { campos, remover, invalidos };
  }

  for (const [chave, valor] of Object.entries(entrada as Record<string, unknown>)) {
    const tipo = Object.hasOwn(CAMPOS_FICHA, chave)
      ? CAMPOS_FICHA[chave as keyof typeof CAMPOS_FICHA]
      : null;
    if (!tipo) {
      invalidos.push(chave);
      continue;
    }
    if (valor === undefined) continue; // só chega por chamada JS; JSON não produz undefined
    if (valor === null) {
      remover.push(chave);
      continue;
    }
    if (tipo === 'lista') {
      if (!Array.isArray(valor) || valor.some((i) => typeof i !== 'string')) {
        invalidos.push(chave);
        continue;
      }
      const itens = [...new Set((valor as string[]).map((s) => s.trim()).filter(Boolean))];
      if (itens.length) campos[chave] = itens;
      else remover.push(chave);
      continue;
    }
    if (typeof valor !== 'string') {
      invalidos.push(chave);
      continue;
    }
    const texto = valor.trim();
    if (texto) campos[chave] = texto;
    else remover.push(chave);
  }

  return { campos: campos as Partial<LeadExtraido>, remover, invalidos };
}
