/**
 * Decode XML/HTML character entities in metadata text.
 *
 * Some producer tools double-escape OPF metadata (e.g. `<dc:creator>`
 * contains `&amp;lt;unknown&amp;gt;`), so the parsed value still carries
 * entity markup. Decoding once at parse/display time restores `<unknown>`.
 * Only a single pass is applied so legitimately literal ampersands survive.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

const ENTITY_RE = /&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g;

export function decodeXmlEntitiesOnce(text: string): string {
  if (!text || text.indexOf("&") < 0 || text.indexOf(";") < 0) return text;
  return text.replace(ENTITY_RE, (match, body: string) => {
    if (body[0] === "#") {
      const hex = body[1]?.toLowerCase() === "x";
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isSafeInteger(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}
