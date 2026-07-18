/**
 * Valida que o modelo de transcrição configurado ACEITA áudio na API real.
 * Gera 1s de WAV sintético (silêncio, PCM 16-bit) em memória e chama
 * transcribeAudio(). Sucesso = retorna null ("[inaudível]") SEM erro de API.
 * Falha típica que este teste pega: modelo inexistente/descontinuado (404) —
 * foi exatamente o que derrubou o áudio em produção em 17/07/2026
 * (GEMINI_TRANSCRIBE_MODEL=gemini-2.5-flash-lite, descontinuado).
 *
 * Rodar:  npx tsx --env-file=.env.local scripts/test-transcribe-live.ts
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

import { transcribeAudio } from '../src/lib/transcribe';

/** WAV PCM 16-bit mono 16kHz com `seconds` de silêncio — só headers + zeros. */
function wavSilencio(seconds: number): Buffer {
  const sampleRate = 16000;
  const numSamples = sampleRate * seconds;
  const dataSize = numSamples * 2; // 16-bit mono
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY ausente. Rode: npx tsx --env-file=.env.local scripts/test-transcribe-live.ts');
    process.exit(1);
  }
  const modelo = process.env.GEMINI_TRANSCRIBE_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  console.log(`Modelo de transcrição em uso: ${modelo}`);
  console.log('Enviando 1s de WAV sintético (silêncio)...');

  // transcribeAudio nunca lança — mas LOGA o erro real no console. Silêncio deve
  // voltar null SEM log de "[transcribe] falha". Interceptamos o console.error
  // pra transformar erro de API em falha do teste.
  const apiErrors: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => {
    const s = args.map(String).join(' ');
    if (/\[transcribe\] falha/.test(s)) apiErrors.push(s);
    origError(...args);
  };

  const out = await transcribeAudio(wavSilencio(1), 'audio/wav');
  console.error = origError;

  if (apiErrors.length > 0) {
    console.error('\nFALHOU — o modelo rejeitou a chamada de áudio:');
    console.error(apiErrors[0].slice(0, 400));
    console.error('\nCorrija GEMINI_TRANSCRIBE_MODEL (ou remova pra usar o default).');
    process.exit(1);
  }
  console.log(`\nOK — modelo aceita áudio (retorno p/ silêncio: ${JSON.stringify(out)}, esperado null/[inaudível]).`);
}

main();
