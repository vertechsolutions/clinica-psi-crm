/**
 * Roda a suíte PURA (sem rede, sem banco, sem chave de API) e resume.
 * Existe porque a suíte era 13 comandos soltos que ninguém digitava inteiros —
 * e um teste que não roda não protege nada.
 *
 * Rodar:  npm test
 *
 * Fora daqui, de propósito (precisam de credencial ou banco):
 *   npm run test:db                                        Postgres de teste
 *   npx tsx --env-file=.env.local scripts/test-triagem.ts  Gemini (27 cenários)
 *   npx tsx --env-file=.env.local scripts/sim-conversa.ts  Gemini (7 personas)
 *   npx tsx --env-file=.env.local scripts/test-sheets-live.ts
 *   npx tsx --env-file=.env.local scripts/test-transcribe-live.ts
 *   npx tsx --env-file=.env.local scripts/test-comprovante-live.ts <arquivo>
 *   DATABASE_PUBLIC_URL=... npx tsx --env-file=.env.local scripts/replay-conversas.ts
 *   DATABASE_PUBLIC_URL=... npx tsx scripts/sync-prompt.ts        prompt do banco
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const PUROS = [
  'test-wa-provider', // autenticação do webhook + parse dos dois providers
  'test-wa-envio', // envio, mídia e bolhas com fetch falso
  'test-legado', // hash/variantes da lista de conversas antigas da Bruna
  'test-zapi-chats', // coleta paginada dos chats do aparelho
  'test-comprovante-core', // validação do Pix (inclui chave mascarada)
  'test-fechamento', // as 4 bolhas oficiais + backstop de handoff
  'test-retomada', // [ONDE PARAMOS] e [JÁ TRATADO]
  'test-ficha', // merge/sanitização da ficha do paciente
  'test-contato', // nome do paciente (nunca re-perguntar)
  'test-conducao', // todo turno avança a conversa
  'test-anti-repeat', // não repetir a mesma resposta
  'test-split', // quebra em bolhas
  'test-agenda', // parsers da planilha
  'test-followup', // canal do reengajamento
  'test-parse-modelo', // saída do modelo que vem quebrada
  'test-emoji', // nada que chega ao paciente tem emoji (e preço/acento sobrevivem)
  'test-anti-bot', // três turnos idênticos são robô — rajada e anexo não são
  'test-turno-agenda', // debounce por turno: rajada vira UMA resposta (relógio falso)
  'test-voz', // a pausa cala o turno em vôo (a Bruna assumiu o chat)
  'test-vocativo', // o nome do paciente com parcimônia, sem mutilar a frase
  'test-pagamento', // não pede Pix antes do horário aceito — e não trava a venda
  'test-prompt', // os defeitos não voltam pela edição do prompt
];

const raiz = path.resolve(import.meta.dirname ?? __dirname, '..');
const falhas: string[] = [];
const inicio = Date.now();

for (const nome of PUROS) {
  const r = spawnSync('npx', ['tsx', path.join('scripts', `${nome}.ts`)], {
    cwd: raiz,
    encoding: 'utf8',
    shell: true,
  });
  const ok = r.status === 0;
  if (!ok) {
    falhas.push(nome);
    console.log(`\n✖ ${nome}`);
    // só o essencial do erro: a saída inteira de 13 scripts vira ruído
    const saida = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(0, 25);
    console.log(saida.map((l) => `    ${l}`).join('\n'));
  } else {
    console.log(`✔ ${nome}`);
  }
}

const seg = ((Date.now() - inicio) / 1000).toFixed(1);
console.log(`\n${PUROS.length - falhas.length}/${PUROS.length} suítes passaram em ${seg}s`);
if (falhas.length) {
  console.log(`falharam: ${falhas.join(', ')}`);
  process.exit(1);
}
