// Decide o primeiro nome do paciente pra injetar no contexto da Camila e nunca
// mais re-perguntar (bug reportado pela Bruna em 25/07). Funções puras.

/** Palavras que denunciam que o "nome" do WhatsApp é empresa/serviço/aparelho, não pessoa. */
const NAO_E_PESSOA =
  /\b(cl[íi]nica|loja|studio|est[úu]dio|atendimento|comercial|delivery|servi[çc]os?|ltda|mei|oficial|contato|vendas|suporte|imobili[áa]ria|iphone|samsung|galaxy|redmi|xiaomi|motorola)\b/i;

/**
 * Extrai um primeiro nome utilizável do nome de perfil do WhatsApp (pushName).
 * O pushName é livre: pode ser "Maria 🦋", "Loja X", "iPhone de João", "😎".
 * Retorna o primeiro token que pareça nome de pessoa (só letras/acentos), capitalizado,
 * ou null quando não dá pra confiar.
 */
export function primeiroNomeDoPush(pushName?: string | null): string | null {
  if (!pushName) return null;
  if (NAO_E_PESSOA.test(pushName)) return null;
  // mantém só letras (com acento), espaço, hífen e apóstrofo; joga fora emoji/dígitos/símbolos
  const limpo = pushName.replace(/[^\p{L}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!limpo) return null;
  const primeiro = limpo.split(' ')[0];
  if (primeiro.length < 2 || primeiro.length > 20) return null;
  if (/^(de|da|do|dos|das|e)$/i.test(primeiro)) return null;
  return primeiro.charAt(0).toUpperCase() + primeiro.slice(1).toLowerCase();
}

/**
 * Bloco de contexto com o primeiro nome já conhecido. Prioridade: nome da FICHA
 * (o que a pessoa realmente disse / foi extraído) > nome do WhatsApp (pushName).
 * String vazia quando não há nome confiável (aí a Camila pergunta 1x como sempre).
 */
export function blocoContatoDe(nomeFicha?: string | null, pushName?: string | null): string {
  const ficha = nomeFicha && nomeFicha.trim() ? nomeFicha.trim() : null;
  // "Use-o com naturalidade" era a redação até 11/08/2026, e este bloco é
  // injetado a CADA turno — o modelo lia como licença de vocativo por turno e
  // saía "Entendi, Eldilaine" / "Ótimo, Eldilaine" / "Perfeito, Eldilaine" em
  // sequência (print da Bruna). A parcimônia agora é explícita e numérica; o
  // `vocativo.ts` é a garantia de código, porque o prompt efetivo pode vir do
  // `app_config` e estar congelado numa versão antiga.
  const PARCIMONIA =
    'Use o nome com PARCIMÔNIA: no máximo uma vez a cada três mensagens suas, e NUNCA em duas mensagens seguidas. Chamar a pessoa pelo nome a cada turno soa robótico. Na dúvida, não use.';
  if (ficha) {
    return `[DADOS DO CONTATO]\nVocê já sabe o primeiro nome do paciente: ${ficha}. ${PARCIMONIA} E NUNCA pergunte o nome de novo (a etapa 3 do funil já está cumprida). Nunca peça o nome completo — o nome oficial vem no formulário de triagem.`;
  }
  const push = primeiroNomeDoPush(pushName);
  if (push) {
    return `[DADOS DO CONTATO]\nO nome do contato no WhatsApp é "${push}" — provavelmente o primeiro nome da pessoa. ${PARCIMONIA} E NÃO peça o primeiro nome (a etapa 3 já está coberta). Se a pessoa se apresentar com outro nome, adote o novo. Nunca peça o nome completo.`;
  }
  return '';
}
