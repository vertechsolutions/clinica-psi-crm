/**
 * Replay das conversas REAIS (histórico do Postgres de produção) contra o
 * raciocínio ATUAL da Camila (prompt do código + agenda real do Sheets).
 *
 * Para cada mensagem de usuário no log, monta o histórico até aquele ponto
 * (com as respostas ANTIGAS, preservando o contexto original) e gera a resposta
 * NOVA via runTriagem(). Imprime lado a lado ANTIGA vs NOVA (+ bolhas) pra
 * avaliação qualitativa de regressão/evolução. Nada é enviado ao WhatsApp.
 *
 * LGPD: telefones mascarados (***últimos4); rode localmente e não versione a saída.
 *
 * Pré: DATABASE_PUBLIC_URL no ambiente (passe via shell; NÃO commitar).
 * Rodar:
 *   DATABASE_PUBLIC_URL=... npx tsx --env-file=.env.local scripts/replay-conversas.ts
 */
import { readFileSync } from 'node:fs';
try {
  for (const linha of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = linha.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) {
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  }
} catch {}

import { Client } from 'pg';
import { runTriagemSemRepeticao } from '../src/lib/anti-repeat';
import { DEFAULT_PROMPT } from '../src/lib/default-prompt';
import { splitReply } from '../src/lib/split-message';
import { agendaContexto } from '../src/lib/sheets';

/** Máximo de turnos de usuário re-rodados por conversa (rate limit do free tier). */
const MAX_TURNOS_POR_CONVERSA = 12;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mask = (waId: string) => `***${waId.slice(-4)}`;

interface Msg {
  wa_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: Date;
}

async function main() {
  const dbUrl = process.env.DATABASE_PUBLIC_URL;
  if (!dbUrl) {
    console.error('DATABASE_PUBLIC_URL ausente. Passe via shell (railway variable list -s Postgres).');
    process.exit(1);
  }
  if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY ausente (.env.local).');
    process.exit(1);
  }

  const db = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const { rows } = await db.query<Msg>(
    `SELECT wa_id, role, content, created_at FROM wa_messages ORDER BY wa_id, created_at, id`,
  );
  await db.end();

  // agenda real (mesma que a produção injeta) + FORM_URL como no computeReply
  const agenda = await agendaContexto();
  let system = DEFAULT_PROMPT.replaceAll('{FORM_URL}', process.env.FORM_URL || '{FORM_URL}');
  if (agenda) system = `${system}\n\n${agenda}`;
  console.log(`Agenda no contexto: ${agenda ? 'SIM (' + agenda.length + ' chars)' : 'NÃO'}`);

  const porConversa = new Map<string, Msg[]>();
  for (const m of rows) {
    if (!porConversa.has(m.wa_id)) porConversa.set(m.wa_id, []);
    porConversa.get(m.wa_id)!.push(m);
  }
  console.log(`Conversas no banco: ${porConversa.size} · mensagens: ${rows.length}\n`);

  for (const [waId, msgs] of porConversa) {
    console.log(`\n########## CONVERSA ${mask(waId)} — ${msgs.length} msgs (${msgs[0].created_at.toISOString().slice(0, 10)} a ${msgs[msgs.length - 1].created_at.toISOString().slice(0, 10)}) ##########`);
    const history: { role: 'user' | 'assistant'; content: string }[] = [];
    let turnos = 0;

    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.role === 'user') {
        // resposta antiga = próxima assistant no log (se houver)
        const antiga = msgs[i + 1]?.role === 'assistant' ? msgs[i + 1].content : '(sem resposta no log)';
        if (turnos < MAX_TURNOS_POR_CONVERSA) {
          history.push({ role: 'user', content: m.content });
          try {
            const res = await runTriagemSemRepeticao({ system, messages: history });
            const bolhas = splitReply(res.resposta);
            console.log(`\n[turno ${turnos + 1}] paciente: ${m.content.slice(0, 160)}`);
            console.log(`  ANTIGA: ${antiga.slice(0, 220)}`);
            bolhas.forEach((b, k) => console.log(`  NOVA#${k + 1}: ${b.slice(0, 220)}`));
            if (res.enviarForm) console.log('  >> NOVA marcou enviarForm=true');
            // repõe a resposta ANTIGA no histórico (preserva o fluxo original)
            history.pop();
            history.push({ role: 'user', content: m.content });
            history.push({ role: 'assistant', content: antiga.startsWith('(') ? res.resposta : antiga });
            turnos++;
            await sleep(1300);
          } catch (e) {
            console.log(`  ERRO no replay: ${e instanceof Error ? e.message.slice(0, 160) : e}`);
            history.pop();
          }
        } else {
          // além do teto: só mantém o histórico andando, sem chamar o Gemini
          history.push({ role: 'user', content: m.content });
          if (msgs[i + 1]?.role === 'assistant') history.push({ role: 'assistant', content: msgs[i + 1].content });
        }
      }
    }
    console.log(`\n(${turnos} turnos re-rodados de ${mask(waId)}${turnos >= MAX_TURNOS_POR_CONVERSA ? ' — teto atingido, resto pulado' : ''})`);
  }
  console.log('\nReplay concluído.');
}

main();
