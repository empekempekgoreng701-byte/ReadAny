/**
 * Chapter-level Cache Metadata
 *
 * Tracks whether a full chapter has already been translated so we can
 * skip the per-paragraph cache lookup on subsequent visits.
 * Also stores user's visibility preferences (original/translation visibility).
 */

import { getPlatformService } from "../services/platform";

export const CHAPTER_CACHE_PREFIX = "readany_chapter_translated_";
/** Bump when chapter identity scheme changes; old flags are ignored (safe invalidate). */
export const CHAPTER_CACHE_VERSION = 2;

export type TranslationVisualMode = "original" | "translation" | "bilingual";

export interface ChapterTranslationIdentity {
  bookId: string;
  sectionIndex: number;
  chapterHref?: string;
  chapterId?: string;
  sourceHash?: string;
  sourceLang?: string;
  targetLang: string;
  providerId?: string;
  version?: number;
}

export interface ChapterTranslationSettings {
  cached: boolean;
  originalVisible: boolean;
  translationVisible: boolean;
  targetLang: string;
  visualMode?: TranslationVisualMode;
  providerId?: string;
  sourceHash?: string;
  chapterHref?: string;
  /** Translated chapter title (Book Overview list); absent = show original. */
  translatedTitle?: string;
  version?: number;
}

function sanitize(value: string | undefined, maxLen = 96): string {
  if (!value) return "";
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, maxLen);
}

function toIdentity(
  bookId: string,
  sectionIndex: number,
  targetLang: string,
  extra?: Partial<ChapterTranslationIdentity>,
): ChapterTranslationIdentity {
  return {
    bookId,
    sectionIndex,
    targetLang,
    chapterHref: extra?.chapterHref,
    chapterId: extra?.chapterId,
    sourceHash: extra?.sourceHash,
    sourceLang: extra?.sourceLang,
    providerId: extra?.providerId,
    version: extra?.version ?? CHAPTER_CACHE_VERSION,
  };
}

function getChapterKey(
  bookId: string,
  sectionIndex: number,
  targetLang: string,
  extra?: Partial<ChapterTranslationIdentity>,
): string {
  const id = toIdentity(bookId, sectionIndex, targetLang, extra);
  const base = `${CHAPTER_CACHE_PREFIX}${sanitize(bookId, 48)}_${sectionIndex}_${sanitize(targetLang, 16)}`;
  if (
    (id.version ?? CHAPTER_CACHE_VERSION) >= 2 &&
    (id.providerId || id.sourceHash || id.chapterHref || id.chapterId)
  ) {
    const parts = [base, `v${CHAPTER_CACHE_VERSION}`];
    if (id.providerId) parts.push(`p_${sanitize(id.providerId, 24)}`);
    const chapter = sanitize(id.chapterId || id.chapterHref, 80);
    if (chapter) parts.push(`c_${chapter}`);
    if (id.sourceHash) parts.push(`s_${sanitize(id.sourceHash, 32)}`);
    return parts.join("_");
  }
  return base;
}

function getLegacyChapterKey(bookId: string, sectionIndex: number, targetLang: string): string {
  return `${CHAPTER_CACHE_PREFIX}${bookId}_${sectionIndex}_${targetLang}`;
}

function getChapterSettingsKey(bookId: string, sectionIndex: number, targetLang?: string): string {
  const base = `${CHAPTER_CACHE_PREFIX}${sanitize(bookId, 48)}_${sectionIndex}_settings`;
  return targetLang ? `${base}_${sanitize(targetLang, 16)}` : base;
}

export function toVisualMode(
  originalVisible: boolean,
  translationVisible: boolean,
): TranslationVisualMode {
  if (originalVisible && translationVisible) return "bilingual";
  if (!originalVisible && translationVisible) return "translation";
  return "original";
}

export function fromVisualMode(mode: TranslationVisualMode): {
  originalVisible: boolean;
  translationVisible: boolean;
} {
  switch (mode) {
    case "translation":
      return { originalVisible: false, translationVisible: true };
    case "bilingual":
      return { originalVisible: true, translationVisible: true };
    default:
      return { originalVisible: true, translationVisible: false };
  }
}

/** Check if every paragraph in a chapter is already cached (v2-aware, legacy fallback) */
export async function isChapterFullyCached(
  bookId: string,
  sectionIndex: number,
  targetLang: string,
  extra?: Partial<ChapterTranslationIdentity>,
): Promise<boolean> {
  try {
    const platform = getPlatformService();
    if (extra && (extra.providerId || extra.sourceHash || extra.chapterHref || extra.chapterId)) {
      const key = getChapterKey(bookId, sectionIndex, targetLang, extra);
      const value = await platform.kvGetItem(key);
      return value === "1";
    }
    // No identity: accept any v2 flag for this book/section/lang (provider-agnostic legacy path).
    const allKeys = await platform.kvGetAllKeys();
    const base = `${CHAPTER_CACHE_PREFIX}${sanitize(bookId, 48)}_${sectionIndex}_${sanitize(targetLang, 16)}`;
    const legacy = getLegacyChapterKey(bookId, sectionIndex, targetLang);
    for (const k of allKeys) {
      if (k === legacy || k.startsWith(`${base}_`) || k.startsWith(base)) {
        const v = await platform.kvGetItem(k);
        if (v === "1") return true;
      }
    }
    return false;
  } catch (err) {
    console.warn("[Translation] Failed to check chapter cache status:", err);
    return false;
  }
}

/** Get chapter translation settings (visibility preferences), scoped by targetLang when available */
export async function getChapterTranslationSettings(
  bookId: string,
  sectionIndex: number,
  targetLang?: string,
): Promise<ChapterTranslationSettings | null> {
  try {
    const platform = getPlatformService();
    if (targetLang) {
      const scoped = await platform.kvGetItem(
        getChapterSettingsKey(bookId, sectionIndex, targetLang),
      );
      if (scoped) return JSON.parse(scoped) as ChapterTranslationSettings;
    }
    const key = getChapterSettingsKey(bookId, sectionIndex);
    const value = await platform.kvGetItem(key);
    if (value) {
      const parsed = JSON.parse(value) as ChapterTranslationSettings;
      // Do not reuse visibility across different target languages.
      if (targetLang && parsed.targetLang && parsed.targetLang !== targetLang) return null;
      return parsed;
    }
    // Legacy raw key (unsanitized bookId).
    const legacyKey = `${CHAPTER_CACHE_PREFIX}${bookId}_${sectionIndex}_settings`;
    if (legacyKey !== key) {
      const legacy = await platform.kvGetItem(legacyKey);
      if (legacy) {
        const parsed = JSON.parse(legacy) as ChapterTranslationSettings;
        if (targetLang && parsed.targetLang && parsed.targetLang !== targetLang) return null;
        return parsed;
      }
    }
    return null;
  } catch (err) {
    console.warn("[Translation] Failed to get chapter translation settings:", err);
    return null;
  }
}

export interface MarkChapterCachedVerification {
  expectedCount: number;
  actualCount: number;
  hasEmpty: boolean;
}

/** Mark a chapter as fully cached (call after all paragraphs translated) */
export async function markChapterFullyCached(
  bookId: string,
  sectionIndex: number,
  targetLang: string,
  extra?: Partial<ChapterTranslationIdentity> & {
    verification?: MarkChapterCachedVerification;
    /** Translated chapter title (stored for the Book Overview list). */
    translatedTitle?: string;
  },
): Promise<boolean> {
  try {
    if (extra?.verification) {
      const v = extra.verification;
      if (v.expectedCount <= 0 || v.actualCount < v.expectedCount || v.hasEmpty) {
        console.warn(
          `[Translation] Refusing to mark chapter cached: expected=${v.expectedCount} actual=${v.actualCount} empty=${v.hasEmpty}`,
        );
        return false;
      }
    }
    const platform = getPlatformService();
    const key = getChapterKey(bookId, sectionIndex, targetLang, extra);
    await platform.kvSetItem(key, "1");

    const settingsKey = getChapterSettingsKey(bookId, sectionIndex, targetLang);
    const existing = await getChapterTranslationSettings(bookId, sectionIndex, targetLang);
    const settings: ChapterTranslationSettings = {
      cached: true,
      originalVisible: existing?.originalVisible ?? true,
      translationVisible: existing?.translationVisible ?? true,
      visualMode: existing?.visualMode,
      translatedTitle: extra?.translatedTitle ?? existing?.translatedTitle,
      targetLang,
      providerId: extra?.providerId ?? existing?.providerId,
      sourceHash: extra?.sourceHash ?? existing?.sourceHash,
      chapterHref: extra?.chapterHref ?? existing?.chapterHref,
      version: CHAPTER_CACHE_VERSION,
    };
    await platform.kvSetItem(settingsKey, JSON.stringify(settings));
    // Keep legacy unscoped settings in sync for older readers.
    await platform.kvSetItem(getChapterSettingsKey(bookId, sectionIndex), JSON.stringify(settings));
    return true;
  } catch (err) {
    console.warn("[Translation] Failed to mark chapter as cached:", err);
    return false;
  }
}

/** Update chapter translation visibility settings */
export async function updateChapterTranslationSettings(
  bookId: string,
  sectionIndex: number,
  settings: Partial<ChapterTranslationSettings>,
): Promise<void> {
  try {
    const platform = getPlatformService();
    const targetLang = settings.targetLang;
    const key = getChapterSettingsKey(bookId, sectionIndex, targetLang);
    const existing = await getChapterTranslationSettings(bookId, sectionIndex, targetLang);
    const merged: ChapterTranslationSettings = {
      cached: settings.cached ?? existing?.cached ?? true,
      originalVisible: settings.originalVisible ?? existing?.originalVisible ?? true,
      translationVisible: settings.translationVisible ?? existing?.translationVisible ?? true,
      visualMode:
        settings.visualMode ??
        existing?.visualMode ??
        toVisualMode(
          settings.originalVisible ?? existing?.originalVisible ?? true,
          settings.translationVisible ?? existing?.translationVisible ?? true,
        ),
      targetLang: settings.targetLang ?? existing?.targetLang ?? "",
      providerId: settings.providerId ?? existing?.providerId,
      sourceHash: settings.sourceHash ?? existing?.sourceHash,
      chapterHref: settings.chapterHref ?? existing?.chapterHref,
      translatedTitle: settings.translatedTitle ?? existing?.translatedTitle,
      version: CHAPTER_CACHE_VERSION,
    };
    await platform.kvSetItem(key, JSON.stringify(merged));
    await platform.kvSetItem(getChapterSettingsKey(bookId, sectionIndex), JSON.stringify(merged));
  } catch (err) {
    console.warn("[Translation] Failed to update chapter translation settings:", err);
  }
}

/** Clear chapter cache for a specific chapter (chapter flags + settings + v2 scoped paragraphs) */
export async function clearChapterCache(bookId: string, sectionIndex: number): Promise<void> {
  try {
    const platform = getPlatformService();
    const prefixes = [
      `${CHAPTER_CACHE_PREFIX}${bookId}_${sectionIndex}_`,
      `${CHAPTER_CACHE_PREFIX}${sanitize(bookId, 48)}_${sectionIndex}_`,
    ];
    const allKeys = await platform.kvGetAllKeys();
    const keysToRemove = allKeys.filter((k) => prefixes.some((p) => k.startsWith(p)));
    for (const key of keysToRemove) {
      await platform.kvRemoveItem(key);
    }
    // NOTE: v2 paragraph keys are intentionally left alone here. They carry no
    // section scope, so they cannot be safely mapped to this chapter; scoped keys
    // are removed by clearParagraphCacheForChapter when callers provide a stable
    // chapterId. This keeps legacy entries readable.
  } catch (err) {
    console.warn("[Translation] Failed to clear chapter cache:", err);
  }
}

export interface ChapterFlagQuery {
  bookId: string;
  sectionIndex: number;
  targetLang: string;
  /** When given, flags stored for a different provider are excluded. */
  providerId?: string;
}

/**
 * Find stored chapter-complete flags for one chapter from a single key scan
 * (no per-chapter KV reads). Mirrors the matching rules of
 * {@link isChapterFullyCached}: exact legacy key, or the v2
 * `book_section_lang` prefix. A flag carrying a `_v2_p_<otherProvider>`
 * segment is only a match when no provider filter is given or it equals the
 * filter. Callers must still check the stored value (`"1"`).
 */
export function matchChapterFlagKeys(
  allKeys: string[],
  query: ChapterFlagQuery,
): string[] {
  const legacy = getLegacyChapterKey(query.bookId, query.sectionIndex, query.targetLang);
  const base = `${CHAPTER_CACHE_PREFIX}${sanitize(query.bookId, 48)}_${query.sectionIndex}_${sanitize(query.targetLang, 16)}`;
  const providerNeedle = query.providerId
    ? `_v2_p_${sanitize(query.providerId, 24)}`
    : null;
  const out: string[] = [];
  for (const key of allKeys) {
    if (key === legacy) {
      out.push(key);
      continue;
    }
    if (!key.startsWith(base)) continue;
    if (providerNeedle) {
      const providerMatch = key.match(/_v2_p_([^_]+)/);
      if (providerMatch && `_v2_p_${providerMatch[1]}` !== providerNeedle) continue;
    }
    out.push(key);
  }
  return out;
}

/**
 * List every chapter-flag key belonging to one book (single scan). Used by
 * the Book Overview to derive per-chapter statuses without N KV round-trips.
 */
export function listChapterFlagKeysForBook(allKeys: string[], bookId: string): string[] {
  const rawPrefix = `${CHAPTER_CACHE_PREFIX}${bookId}_`;
  const safePrefix = `${CHAPTER_CACHE_PREFIX}${sanitize(bookId, 48)}_`;
  return allKeys.filter(
    (key) =>
      key.startsWith(CHAPTER_CACHE_PREFIX) &&
      (key.startsWith(rawPrefix) || key.startsWith(safePrefix)),
  );
}
