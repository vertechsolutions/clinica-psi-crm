/**
 * Trava de estreia. O transporte agora é o WhatsApp PROFISSIONAL da Bruna, que
 * já tem conversas em andamento — sem isto a Camila responderia todo mundo que
 * escrever, inclusive contato pessoal e paciente que já está sendo atendido por
 * ela. Com `WA_ALLOWLIST` preenchida, só esses números falam com a IA; os outros
 * são ignorados por completo (nem gravamos — dado de terceiro que não pediu
 * triagem não entra no banco). Vazia = atende todo mundo (operação normal).
 *
 * Vive aqui, e não no `route.ts`, porque a varredura de pendentes do boot
 * (`boot-sweep.ts`) precisa aplicar EXATAMENTE o mesmo gate: uma conversa que o
 * webhook ao vivo calaria não pode ser ressuscitada na subida do processo.
 */
export function allowlist(): string[] {
  return (process.env.WA_ALLOWLIST || '')
    .split(',')
    .map((s) => s.replace(/\D/g, ''))
    .filter(Boolean);
}

export function atende(waId: string): boolean {
  const lista = allowlist();
  return lista.length === 0 || lista.includes(waId);
}
