/**
 * Translation service exports
 * Re-exports from modular translation architecture
 */

// Types
export type { TranslationProvider, UseTranslatorOptions, TranslatorName } from "./types";
export { ErrorCodes } from "./types";

// Providers
export { getTranslator, getTranslators, aiProvider, deeplProvider } from "./providers";

// Cache
export {
  getFromCache,
  storeInCache,
  clearTranslationCache,
  clearParagraphCacheForChapter,
  isCompleteTranslation,
  matchParagraphKeysForChapter,
  stableTextHash,
  hashSourceTexts,
  TRANSLATION_CACHE_VERSION,
  type ParagraphChapterQuery,
  type TranslationIdentity,
} from "./cache";

// Chapter-level translation
export {
  translateChapter,
  type ChapterParagraph,
  type ChapterTranslationProgress,
  type ChapterTranslationResult,
  type TranslateChapterOptions,
} from "./chapter-translator";
export {
  isChapterFullyCached,
  markChapterFullyCached,
  clearChapterCache,
  getChapterTranslationSettings,
  updateChapterTranslationSettings,
  listChapterFlagKeysForBook,
  matchChapterFlagKeys,
  toVisualMode,
  fromVisualMode,
  CHAPTER_CACHE_VERSION,
  type ChapterFlagQuery,
  type ChapterTranslationIdentity,
  type ChapterTranslationSettings,
  type TranslationVisualMode,
} from "./chapter-cache";

// Shared text primitives (paragraph normalization, CJK whole-word rule)
export {
  CJK_SCRIPT_RE,
  effectiveWholeWord,
  normalizeParagraphText,
  shouldBypassWholeWordForQuery,
  splitPlainTextToParagraphs,
  type PlainTextParagraph,
} from "./translation-text";

// Book Overview data layer + full-book translation queue
export {
  buildReaderParamsForAnnotation,
  buildReaderParamsForChapter,
  buildReaderParamsForContinue,
  buildReaderParamsForSearch,
  deriveChapterStatuses,
  filterOverviewChapters,
  getTranslatedChapterTitles,
  resolveLibraryTapAction,
  sectionIndexFromCfi,
  setTranslatedChapterTitle,
  sortOverviewChapters,
  type ChapterStatusInput,
  type ChapterTranslationStatus,
  type ChapterSortOrder,
  type ChapterStatusFilter,
  type LibraryTapAction,
  type OverviewChapterRef,
  type ReaderChapterParams,
} from "./book-overview";
export {
  computeResumePending,
  createBookTranslationTask,
  loadBookTranslationTask,
  planBookTranslationScope,
  resolveEffectiveTranslationConfig,
  runBookTranslationQueue,
  saveBookTranslationTask,
  bookTranslationTaskKey,
  type BookQueueDeps,
  type BookQueueEvent,
  type BookTranslationScope,
  type BookTranslationTaskRecord,
  type BookTranslationTaskStatus,
  type RunBookTranslationOptions,
} from "./book-translation-queue";

// Language support
export const SUPPORTED_LANGUAGES = [
  { code: "zh-CN", name: "Chinese (Simplified)", nativeName: "简体中文" },
  { code: "zh-TW", name: "Chinese (Traditional)", nativeName: "繁體中文" },
  { code: "ja", name: "Japanese", nativeName: "日本語" },
  { code: "ko", name: "Korean", nativeName: "한국어" },
  { code: "en", name: "English", nativeName: "English" },
  { code: "fr", name: "French", nativeName: "Français" },
  { code: "de", name: "German", nativeName: "Deutsch" },
  { code: "es", name: "Spanish", nativeName: "Español" },
  { code: "pt", name: "Portuguese", nativeName: "Português" },
  { code: "it", name: "Italian", nativeName: "Italiano" },
  { code: "ru", name: "Russian", nativeName: "Русский" },
  { code: "ar", name: "Arabic", nativeName: "العربية" },
  { code: "th", name: "Thai", nativeName: "ไทย" },
  { code: "vi", name: "Vietnamese", nativeName: "Tiếng Việt" },
  { code: "id", name: "Indonesian", nativeName: "Bahasa Indonesia" },
  { code: "tr", name: "Turkish", nativeName: "Türkçe" },
  { code: "pl", name: "Polish", nativeName: "Polski" },
  { code: "nl", name: "Dutch", nativeName: "Nederlands" },
  { code: "sv", name: "Swedish", nativeName: "Svenska" },
] as const;

export type TranslationTargetLang = (typeof SUPPORTED_LANGUAGES)[number]["code"];

export interface TranslationResult {
  originalText: string;
  translatedText: string;
  targetLang: string;
  confidence?: number;
}

/** Get the display name for a language code */
export function getLanguageName(code: string): string {
  return SUPPORTED_LANGUAGES.find((l) => l.code === code)?.name || code;
}

/** Get the native name for a language code */
export function getLanguageNativeName(code: string): string {
  return SUPPORTED_LANGUAGES.find((l) => l.code === code)?.nativeName || code;
}

/** Legacy translate function for backward compatibility */
export async function translate(
  text: string,
  config: {
    provider: { id: string; apiKey?: string; baseUrl?: string };
    targetLang: string;
    model?: string;
  },
): Promise<TranslationResult> {
  const { getTranslator } = await import("./providers");

  const provider = getTranslator(config.provider.id as any);
  if (!provider) {
    return { originalText: text, translatedText: "", targetLang: config.targetLang };
  }

  try {
    const results = await provider.translate([text], "AUTO", config.targetLang, {
      apiKey: config.provider.apiKey,
      baseUrl: config.provider.baseUrl,
      model: config.model,
    });
    return {
      originalText: text,
      translatedText: results[0] || "",
      targetLang: config.targetLang,
    };
  } catch (error) {
    console.error("Translation error:", error);
    return { originalText: text, translatedText: "", targetLang: config.targetLang };
  }
}

/** Batch translate function */
export async function translateBatch(
  texts: string[],
  config: {
    provider: { id: string; apiKey?: string; baseUrl?: string };
    targetLang: string;
    model?: string;
  },
): Promise<TranslationResult[]> {
  const { getTranslator } = await import("./providers");

  const provider = getTranslator(config.provider.id as any);
  if (!provider) {
    return texts.map((text) => ({
      originalText: text,
      translatedText: "",
      targetLang: config.targetLang,
    }));
  }

  try {
    const results = await provider.translate(texts, "AUTO", config.targetLang, {
      apiKey: config.provider.apiKey,
      baseUrl: config.provider.baseUrl,
      model: config.model,
    });
    return texts.map((text, i) => ({
      originalText: text,
      translatedText: results[i] || "",
      targetLang: config.targetLang,
    }));
  } catch (error) {
    console.error("Batch translation error:", error);
    return texts.map((text) => ({
      originalText: text,
      translatedText: "",
      targetLang: config.targetLang,
    }));
  }
}
