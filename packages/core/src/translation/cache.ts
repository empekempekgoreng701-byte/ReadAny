/**
 * Translation Cache
 * Cross-platform cache for translation results using IPlatformService KV storage.
 *
 * All methods are async to support both Web (localStorage) and RN (AsyncStorage).
 */

import { getPlatformService } from "../services/platform";
import type { TranslatorName } from "./types";

export const CACHE_PREFIX = "readany_translation_cache_";
/** Current cache key version. Bumped when identity scheme changes. */
export const TRANSLATION_CACHE_VERSION = 2;

/**
 * Stable identity for a paragraph translation.
 * New keys include book/chapter/sourceHash when available so identical
 * sentences in different books/chapters do not collide.
 */
export interface TranslationIdentity {
  bookId?: string;
  chapterId?: string;
  chapterHref?: string;
  sourceHash?: string;
  version?: number;
}

function sanitizeKeyPart(value: string | undefined, maxLen = 64): string {
  if (!value) return "";
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, maxLen);
}

/** Legacy 32-bit hash (kept for backward-compatible reads). */
export function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36);
}

/**
 * Stronger 53-bit hash (cyrb53) + length. Much lower collision rate
 * than the legacy 32-bit hash at book scale.
 */
export function stableTextHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hash53 = (h2 >>> 0) * 4294967296 + (h1 >>> 0);
  return `${hash53.toString(36)}_${text.length}`;
}

/** Hash a whole chapter source (ordered paragraph texts) for identity. */
export function hashSourceTexts(texts: string[]): string {
  return stableTextHash(texts.join("\n\u0000\n"));
}

/** Generate cache key (v2 when identity provided, legacy shape otherwise) */
function getCacheKey(
  text: string,
  sourceLang: string,
  targetLang: string,
  provider: TranslatorName,
  identity?: TranslationIdentity,
): string {
  const version = identity?.version ?? TRANSLATION_CACHE_VERSION;
  if (
    version >= 2 &&
    (identity?.bookId || identity?.chapterId || identity?.chapterHref || identity?.sourceHash)
  ) {
    const book = sanitizeKeyPart(identity?.bookId, 48);
    const chapter = sanitizeKeyPart(identity?.chapterId || identity?.chapterHref, 80);
    const source = sanitizeKeyPart(identity?.sourceHash, 32);
    const hash = stableTextHash(text);
    const parts = [`${CACHE_PREFIX}v2`, provider, sourceLang, targetLang, hash];
    if (book) parts.push(`b_${book}`);
    if (chapter) parts.push(`c_${chapter}`);
    if (source) parts.push(`s_${source}`);
    return parts.join("_");
  }
  const hash = simpleHash(text);
  return `${CACHE_PREFIX}${provider}_${sourceLang}_${targetLang}_${hash}`;
}

function getLegacyKey(
  text: string,
  sourceLang: string,
  targetLang: string,
  provider: TranslatorName,
): string {
  return `${CACHE_PREFIX}${provider}_${sourceLang}_${targetLang}_${simpleHash(text)}`;
}

/** Get translation from cache (tries v2 key first, falls back to legacy for migration) */
export async function getFromCache(
  text: string,
  sourceLang: string,
  targetLang: string,
  provider: TranslatorName,
  identity?: TranslationIdentity,
): Promise<string | null> {
  try {
    const platform = getPlatformService();
    const keys: string[] = [];
    if (
      identity &&
      (identity.bookId || identity.chapterId || identity.chapterHref || identity.sourceHash)
    ) {
      keys.push(getCacheKey(text, sourceLang, targetLang, provider, identity));
    } else if (identity?.version !== undefined) {
      keys.push(getCacheKey(text, sourceLang, targetLang, provider, identity));
    }
    // Always try the plain v2 scoped key shape is covered above; try legacy last.
    const legacyKey = getLegacyKey(text, sourceLang, targetLang, provider);
    if (!keys.includes(legacyKey)) keys.push(legacyKey);
    // Also try unscoped v2 (hash-only) key for entries written without identity.
    const unscopedV2 = getCacheKey(text, sourceLang, targetLang, provider, {
      version: TRANSLATION_CACHE_VERSION,
    });
    if (!keys.includes(unscopedV2)) keys.splice(keys.length - 1, 0, unscopedV2);

    for (const key of keys) {
      const cached = await platform.kvGetItem(key);
      if (cached) {
        try {
          const { translation, timestamp } = JSON.parse(cached);
          if (typeof translation !== "string" || !translation) continue;
          // Cache expires after 7 days
          if (Date.now() - timestamp < 7 * 24 * 60 * 60 * 1000) {
            return translation;
          }
          await platform.kvRemoveItem(key);
        } catch {
          // Corrupt entry — fall through to the next key.
        }
      }
    }
  } catch (err) {
    console.warn("[Translation] Cache read error:", err);
  }
  return null;
}

/** Store translation in cache (writes versioned key; never writes empty strings) */
export async function storeInCache(
  text: string,
  translation: string,
  sourceLang: string,
  targetLang: string,
  provider: TranslatorName,
  identity?: TranslationIdentity,
): Promise<void> {
  if (!translation) return;
  try {
    const platform = getPlatformService();
    const key = getCacheKey(text, sourceLang, targetLang, provider, identity);
    await platform.kvSetItem(
      key,
      JSON.stringify({
        translation,
        timestamp: Date.now(),
        v: TRANSLATION_CACHE_VERSION,
      }),
    );
  } catch (err) {
    console.warn("[Translation] Cache write error:", err);
  }
}

/** Remove paragraph entries belonging to a chapter (only v2 scoped keys can be targeted). */
export async function clearParagraphCacheForChapter(
  bookId: string,
  chapterId: string,
): Promise<void> {
  try {
    const platform = getPlatformService();
    const allKeys = await platform.kvGetAllKeys();
    const bookPart = `b_${sanitizeKeyPart(bookId, 48)}`;
    const chapterPart = `c_${sanitizeKeyPart(chapterId, 80)}`;
    const targets = allKeys.filter(
      (k) => k.startsWith(CACHE_PREFIX) && k.includes(bookPart) && k.includes(chapterPart),
    );
    await Promise.all(targets.map((k) => platform.kvRemoveItem(k)));
  } catch (err) {
    console.warn("[Translation] Failed to clear chapter paragraphs:", err);
  }
}

export interface ParagraphChapterQuery {
  bookId?: string;
  /** Stable chapter id (reader scheme: `String(sectionIndex)`). */
  chapterId?: string | number;
  chapterHref?: string;
  /** When given, only keys stored for this provider match. */
  provider?: string;
  /** When given, only keys stored for this target language match. */
  targetLang?: string;
}

/**
 * Find stored paragraph translations belonging to one chapter from a single
 * key scan. Only v2 scoped keys can be attributed (legacy keys carry no
 * chapter scope and are ignored). Same sanitize scheme as the writer, so the
 * key format stays single-sourced here.
 */
export function matchParagraphKeysForChapter(
  allKeys: string[],
  query: ParagraphChapterQuery,
): string[] {
  const bookPart = query.bookId ? `b_${sanitizeKeyPart(query.bookId, 48)}` : null;
  const chapterRaw =
    query.chapterId != null && String(query.chapterId) !== ""
      ? String(query.chapterId)
      : query.chapterHref;
  const chapterPart = chapterRaw ? `c_${sanitizeKeyPart(chapterRaw, 80)}` : null;
  if (!chapterPart && !bookPart) return [];
  return allKeys.filter((key) => {
    if (!key.startsWith(CACHE_PREFIX)) return false;
    if (bookPart && !key.includes(bookPart)) return false;
    if (chapterPart && !key.includes(chapterPart)) return false;
    if (query.provider && !key.includes(`_${query.provider}_`)) return false;
    if (query.targetLang && !key.includes(`_${query.targetLang}_`)) return false;
    return true;
  });
}

/** Verify every required paragraph has a non-empty persisted translation. */
export function isCompleteTranslation(
  results: Array<{ translatedText?: string }>,
  expectedCount: number,
): boolean {
  if (expectedCount <= 0 || results.length < expectedCount) return false;
  return results.every((r) => typeof r.translatedText === "string" && r.translatedText.length > 0);
}

/** Clear all translation cache */
export async function clearTranslationCache(): Promise<void> {
  try {
    const platform = getPlatformService();
    const allKeys = await platform.kvGetAllKeys();
    const keysToRemove = allKeys.filter((key) => key.startsWith(CACHE_PREFIX));
    await Promise.all(keysToRemove.map((key) => platform.kvRemoveItem(key)));
  } catch (err) {
    console.warn("[Translation] Failed to clear translation cache:", err);
  }
}
