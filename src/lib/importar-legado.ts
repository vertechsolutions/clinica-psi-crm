/**
 * Importador da lista de legado: lê as conversas que já existem no celular da
 * Bruna (via Z-API) e grava o hash de cada número.
 *
 * Roda DENTRO do app, não como script na máquina de alguém. A diferença importa:
 * a lista de contatos de um celular pessoal-profissional nunca sai da fronteira de
 * produção, ninguém precisa da credencial do banco num laptop, e não sobra
 * scrollback de terminal com a agenda dela. O relatório é só agregado.
 */
import { coletarChats, coletarContatos, type Coleta } from './wa/zapi';
import { telefonesParaLegado } from './legado-core';
import {
  classificarNovos,
  jaAtendidosPelaCamila,
  marcarLegadoEmLote,
  registrarSnapshot,
} from './legado';

export interface ResultadoImport {
  /** false = alguma página falhou; a lista está incompleta e NÃO foi carimbada */
  completo: boolean;
  gravado: boolean;
  paginas: number;
  vistos: number;
  grupos: number;
  invalidos: number;
  daEquipe: number;
  /** chats que a própria Camila já atendeu — excluídos da lista */
  daCamila: number;
  candidatos: number;
  novos: number;
  jaNaLista: number;
  semData: number;
  dozeDigitos: number;
  erro?: string;
}

export interface OpcoesImport {
  /** true = só relatório, não grava nada (o padrão, de propósito) */
  dry?: boolean;
  /** também varre a agenda (`/contacts`), pra pegar quem teve a conversa apagada */
  contatos?: boolean;
  /** total de candidatos do DRY anterior — a gravação aborta se divergir muito */
  esperado?: number;
  /** tolerância do delta contra `esperado`, em fração (default 5%) */
  tolerancia?: number;
}

const vazia = (): Coleta => ({ completo: true, chats: [], paginas: 0 });

/** Resultado zerado, pra recusar o import sem ter que preencher 12 campos. */
const vazio = (): ResultadoImport => ({
  completo: false,
  gravado: false,
  paginas: 0,
  vistos: 0,
  grupos: 0,
  invalidos: 0,
  daEquipe: 0,
  daCamila: 0,
  candidatos: 0,
  novos: 0,
  jaNaLista: 0,
  semData: 0,
  dozeDigitos: 0,
});

export async function importarLegado(opts: OpcoesImport = {}): Promise<ResultadoImport> {
  const dry = opts.dry !== false; // padrão é a seco

  // Sem a chave, o HMAC vira hash sem segredo — e telefone tem espaço de busca
  // pequeno o bastante pra ser revertido em segundos. Pior: quando a chave certa
  // entrasse, nenhum hash da lista casaria e a IA calaria com todo mundo. Recusar
  // é a única saída segura; gravar "e arrumar depois" não existe aqui.
  if (!process.env.WA_LEGADO_CHAVE) {
    return { ...vazio(), erro: 'WA_LEGADO_CHAVE ausente — configure a variável antes de importar' };
  }

  const deChats = await coletarChats();
  const deContatos = opts.contatos ? await coletarContatos() : vazia();

  const chats = [...deChats.chats, ...deContatos.chats];
  const {
    telefones: candidatos,
    grupos,
    invalidos,
    protegidos: daEquipe,
  } = telefonesParaLegado(chats, process.env);

  // Paciente da própria Camila nunca vira "conversa antiga da Bruna". Antes da
  // virada isso não tira ninguém; depois dela, é o que impede uma reconciliação
  // de emudecer os pacientes que a IA conquistou.
  const daCamila = await jaAtendidosPelaCamila(candidatos);
  const telefones = candidatos.filter((t) => !daCamila.has(t));

  const semData = deChats.chats.filter((c) => !c.isGroup && c.semData).length;
  const dozeDigitos = telefones.filter((t) => t.length === 12).length;

  const base: ResultadoImport = {
    completo: deChats.completo && deContatos.completo,
    gravado: false,
    paginas: deChats.paginas + deContatos.paginas,
    vistos: chats.length,
    grupos,
    invalidos,
    daEquipe,
    daCamila: daCamila.size,
    candidatos: telefones.length,
    novos: 0,
    jaNaLista: 0,
    semData,
    dozeDigitos,
    erro: deChats.erro || deContatos.erro,
  };

  const { novos, jaNaLista } = await classificarNovos(telefones);
  base.novos = novos.length;
  base.jaNaLista = jaNaLista;

  if (dry) return base;

  // Uma lista parcial que se apresenta como completa é o pior resultado possível:
  // o operador libera a IA achando que importou tudo, e ela cai em cima das
  // conversas que ficaram de fora. Só carimba o snapshot quando a coleta fechou.
  if (!base.completo) {
    return { ...base, erro: base.erro || 'coleta incompleta — nada gravado' };
  }

  // Trava de procedimento: a gravação exige o total conferido num DRY anterior.
  // É o que impede gravar em cima de um aparelho que ainda estava sincronizando —
  // o passo mais fácil de pular quando o primeiro número "parece razoável".
  if (opts.esperado != null) {
    const tol = opts.tolerancia ?? 0.05;
    const delta = Math.abs(telefones.length - opts.esperado);
    const limite = Math.max(5, Math.round(opts.esperado * tol));
    if (delta > limite) {
      return {
        ...base,
        erro: `delta de ${delta} contra o esperado (${opts.esperado}) passa do limite de ${limite} — rode o DRY de novo`,
      };
    }
  }

  // chats e contatos entram no mesmo lote: uma linha por número, e a distinção de
  // origem só serviria pra diagnóstico — não muda decisão nenhuma.
  const inseridos = await marcarLegadoEmLote(telefones, 'snapshot');
  await registrarSnapshot(telefones.length);
  console.log(
    `[legado] import concluído: ${telefones.length} números na lista (${inseridos} linhas novas, ${base.paginas} páginas).`,
  );
  return { ...base, gravado: true };
}
