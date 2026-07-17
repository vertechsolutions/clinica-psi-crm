/**
 * Diagnóstico da integração com o Google Sheets (agenda da Camila). Lê a planilha
 * real via Service Account e imprime EXATAMENTE o bloco que a Camila injeta no
 * prompt. Use pra validar as credenciais antes do deploy.
 *
 * Pré: no .env.local, defina GOOGLE_SERVICE_ACCOUNT_JSON (o conteúdo do key.json
 * em UMA linha) e AGENDA_SHEET_ID (o id da planilha "Cazule — Agenda").
 *
 * Rodar:  npx tsx --env-file=.env.local scripts/test-sheets-live.ts
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

import { agendaContexto } from '../src/lib/sheets';

async function main() {
  const hasJson = !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const id = process.env.AGENDA_SHEET_ID || '(vazio)';
  console.log(`GOOGLE_SERVICE_ACCOUNT_JSON definido: ${hasJson}`);
  console.log(`AGENDA_SHEET_ID: ${id}`);
  if (hasJson) {
    try {
      const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON as string) as { client_email?: string };
      console.log(`service account: ${sa.client_email ?? '(sem client_email!)'}`);
      console.log('>> Confirme que a planilha está COMPARTILHADA com esse e-mail (Leitor).');
    } catch {
      console.log('>> GOOGLE_SERVICE_ACCOUNT_JSON não é JSON válido — cole o key.json inteiro em uma linha.');
    }
  }

  console.log('\nBuscando a agenda...');
  const ctx = await agendaContexto();
  if (!ctx) {
    console.log('\n>> agendaContexto() voltou VAZIO. Cheque (se houve erro [sheets] acima, ele diz o motivo):');
    console.log('   - as duas env vars estão setadas?');
    console.log('   - a planilha foi compartilhada com o e-mail da service account?');
    console.log('   - as abas se chamam exatamente: Psicólogas / Grade Semanal / Agenda?');
    process.exit(1);
  }
  console.log('\n=== BLOCO QUE A CAMILA VAI VER (injetado no prompt) ===\n');
  console.log(ctx);
  console.log('\nOK — integração da agenda funcionando.');
}

main();
