/**
 * Diagnóstico ao vivo: analisa um comprovante real e mostra o marcador que a
 * Camila veria. Rodar: npx tsx --env-file=.env.local scripts/test-comprovante-live.ts <caminho-imagem-ou-pdf>
 */
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { analisarComprovante } from '../src/lib/comprovante';
import { montarMarcadorComprovante, verificarDestinatario, chaveEsperada } from '../src/lib/comprovante-core';

const MIMES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

async function main() {
  const caminho = process.argv[2];
  if (!caminho) {
    console.error('Uso: npx tsx --env-file=.env.local scripts/test-comprovante-live.ts <arquivo>');
    process.exit(1);
  }
  const mime = MIMES[extname(caminho).toLowerCase()];
  if (!mime) {
    console.error(`Extensão não suportada: ${caminho}`);
    process.exit(1);
  }
  const bytes = readFileSync(caminho);
  console.log(`Analisando ${caminho} (${bytes.length} bytes, ${mime})...`);
  const analise = await analisarComprovante(bytes, mime);
  console.log('\nAnálise:', JSON.stringify(analise, null, 2));
  const verif = analise ? verificarDestinatario(analise, chaveEsperada()) : 'inconclusivo';
  console.log(`\nVerificação do destinatário (esperado: "${chaveEsperada()}"): ${verif}`);
  console.log('\nMarcador que a Camila veria:\n' + montarMarcadorComprovante(analise, verif));
}
main();
