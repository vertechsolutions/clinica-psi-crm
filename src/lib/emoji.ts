/**
 * Filtro de emoji das mensagens que chegam ao paciente. Pedida da Bruna
 * (06/08/2026): a Camila não usa emoji — o tom de clínica de psicologia não
 * combina com carinha, e "emoji demais" foi o que mais denunciou robô nos prints.
 *
 * Isto é a REDE, não a origem: o prompt também foi limpo (`default-prompt.ts`),
 * mas o prompt salvo no banco vence o do código e o modelo é probabilístico —
 * então o filtro roda determinístico em TODO ponto de saída, sempre.
 *
 * Função pura. Não vale pra alerta interno da equipe: lá os emoji são marcador de
 * campo e a Bruna quer que continuem (story 8 do design).
 */

/**
 * A classe de caracteres a remover.
 *
 * **PROIBIDO usar `\p{Emoji}` aqui.** Ele casa `0-9`, `#` e `*` — destruiria
 * "R$ 180,00", "#1" e a lista numerada. `Extended_Pictographic` é a propriedade
 * que pega os pictográficos de verdade (inclusive os antigos sem cor, tipo ⚠).
 *
 * O resto da classe são os MODIFICADORES, que sozinhos não são pictográficos mas
 * ficariam órfãos na tela:
 *   · U+1F3FB–U+1F3FF  tons de pele (👍🏽 → sem eles sobraria o quadradinho)
 *   · U+200D           zero-width joiner (é ele que cola 👨‍👩‍👧‍👦 numa figura só)
 *   · U+FE0F           variation selector-16 (a "versão colorida" do glifo)
 *   · U+20E3           combining enclosing keycap
 *
 * O dígito base do keycap NÃO está na classe de propósito: `5️⃣` vira `5`, que é
 * informação legítima (pode ser "5 sessões"), e não um buraco no texto.
 */
const EMOJI_CHAR = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}‍️⃣]/gu;

/**
 * Remove emoji e modificadores, e arruma o espaçamento que sobra.
 *
 * O pós-processamento mexe SÓ em espaço e tab, nunca em `\n`: a quebra dupla é o
 * separador de bolha do `splitReply` e colapsá-la juntaria duas mensagens do
 * WhatsApp numa só. Ordem importa — tira o espaço colado na quebra ANTES de
 * colapsar espaços múltiplos, senão "bom 😊\n" viraria "bom \n".
 */
export function semEmoji(texto: string): string {
  return (texto ?? '')
    .replace(EMOJI_CHAR, '')
    .replace(/[ \t]+\n/g, '\n') // espaço órfão no fim da linha
    .replace(/\n[ \t]+/g, '\n') // espaço órfão no começo da linha
    .replace(/[ \t]{2,}/g, ' ') // "bom  dia" → "bom dia"
    .trim();
}
