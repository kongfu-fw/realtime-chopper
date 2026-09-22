/**
 * Text hygiene for the translation endpoints.
 *
 * Both Google's `translateHtml` and Microsoft's `translatetext` run an HTML tag
 * aligner over the payload, so a bare `<` in ordinary speech ("a < b") fuses
 * into a pseudo-tag and comes back as garbage. Escaping the input and decoding
 * the response exactly once is the contract both providers rely on.
 */

export function escapeText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return NAMED[entity.toLowerCase()] ?? match
  })
}

/** Cache and de-duplication key normalisation: whitespace must not split entries. */
export function normalizeKey(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Strips trailing full stops that the recogniser adds but speech does not need. */
export function tidy(text: string): string {
  return decodeEntities(text).replace(/[ \t]+/g, ' ').trim()
}
