/**
 * Shared paragraph-text primitives.
 *
 * The reader WebView extracts with `el.innerText || el.textContent` while the
 * background (book-overview) queue extracts with DOM `textContent` only
 * (xmldom has no layout). Without a shared normalization these two paths
 * produce different strings for the same paragraph (whitespace runs,
 * indentation, newlines) — which breaks paragraph cache keys, source hashes,
 * and reader-time restore of queue translations.
 *
 * Both paths MUST run extracted text through {@link normalizeParagraphText}.
 * The function is idempotent, so already-collapsed text is byte-identical
 * (no cache churn for well-formed paragraphs).
 */

/** Matches Han (Unihan + Ext-A), CJK compat, Hiragana/Katakana, Hangul. */
export const CJK_SCRIPT_RE = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]/;

/**
 * Collapse all whitespace runs to a single space and trim — an approximation
 * of `innerText` for plain block elements (`p`, headings, `li`, …).
 */
export function normalizeParagraphText(text: string): string {
  if (!text) return "";
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Whole-word matching is meaningless for CJK queries (Han/Hangul/Kana
 * characters are all `\p{L}`, so neighbors almost always "match" and every
 * hit is rejected). Bypass it for queries containing CJK script.
 */
export function shouldBypassWholeWordForQuery(query: string): boolean {
  if (!query) return false;
  return CJK_SCRIPT_RE.test(query);
}

/** Effective whole-word flag after the CJK bypass. */
export function effectiveWholeWord(wholeWord: boolean, query: string): boolean {
  return wholeWord && !shouldBypassWholeWordForQuery(query);
}

export interface PlainTextParagraph {
  id: string;
  text: string;
  tagName: string;
}

/**
 * Split plain text (TXT/MD) into translation paragraphs: blank-line
 * separated, normalized, short fragments skipped, `para_<index>` ids matching
 * the EPUB extractor scheme.
 */
export function splitPlainTextToParagraphs(text: string): PlainTextParagraph[] {
  const out: PlainTextParagraph[] = [];
  const chunks = String(text ?? "").split(/\n\s*\n/);
  let rawIndex = 0;
  for (const chunk of chunks) {
    const lines = chunk.split("\n");
    for (const line of lines) {
      const normalized = normalizeParagraphText(line);
      const id = `para_${rawIndex}`;
      rawIndex += 1;
      if (normalized.length < 2) continue;
      out.push({ id, text: normalized, tagName: "p" });
    }
  }
  return out;
}

export interface ReadAnyTranslationTextApi {
  normalizeParagraphText: (text: string) => string;
  shouldBypassWholeWordForQuery: (query: string) => boolean;
  effectiveWholeWord: (wholeWord: boolean, query: string) => boolean;
}

/** Installs `globalThis.ReadAnyTranslationText` for the reader WebView. */
export function installReadAnyTranslationText(host: unknown): void {
  const scope = host as Record<string, unknown>;
  if (!scope || typeof scope !== "object") return;
  const api: ReadAnyTranslationTextApi = {
    normalizeParagraphText,
    shouldBypassWholeWordForQuery,
    effectiveWholeWord,
  };
  scope.ReadAnyTranslationText = api;
}
