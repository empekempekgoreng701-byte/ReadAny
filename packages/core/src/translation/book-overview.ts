/**
 * Book Overview data layer (Tachiyomi-style chapter list).
 *
 * Principles (adapted from NoveLA behavioral reference, ReadAny architecture):
 * - The overview NEVER calls translation APIs to *check* status: statuses are
 *   derived from persistent metadata (chapter flags + paragraph-key presence
 *   + queue task record) via a single KV key scan.
 * - Status is derived, not stored: no status column can go stale. Absence of
 *   any record means NOT_TRANSLATED.
 * - TRANSLATED requires a stored complete-flag match (targetLang + provider);
 *   source-hash is verified lazily at reader restore time (which has the
 *   chapter text), never in the overview (which must not load chapter text).
 * - Translated titles live in ONE KV record per book+language+provider so the
 *   list renders with a single read.
 */

import { getPlatformService } from "../services/platform";
import { matchParagraphKeysForChapter } from "./cache";
import { matchChapterFlagKeys } from "./chapter-cache";

export type ChapterTranslationStatus =
  | "NOT_TRANSLATED"
  | "TRANSLATING"
  | "TRANSLATED"
  | "PARTIAL"
  | "ERROR";

export interface OverviewChapterRef {
  sectionIndex: number;
  href: string;
  title: string;
  sizeBytes?: number;
}

export interface ChapterStatusInput {
  chapters: OverviewChapterRef[];
  bookId: string;
  targetLang: string;
  providerId?: string;
  /** Full KV key scan (one read for the whole list). */
  allKeys: string[];
  /** Values of matched chapter-flag keys (`"1"` = complete). */
  flagValues: Map<string, string>;
  /** Sections currently being translated (in-memory, from the queue). */
  activeSections?: Set<number>;
  /** Sections that failed in the current/persisted task. */
  failedSections?: Set<number>;
}

/**
 * Derive per-chapter statuses without any translation API calls.
 * Precedence: TRANSLATED (complete flag) > ERROR (task failed) >
 * TRANSLATING (queue active) > PARTIAL (some paragraph keys, no flag) >
 * NOT_TRANSLATED.
 */
export function deriveChapterStatuses(
  input: ChapterStatusInput,
): Map<number, ChapterTranslationStatus> {
  const out = new Map<number, ChapterTranslationStatus>();
  for (const chapter of input.chapters) {
    const section = chapter.sectionIndex;
    const flags = matchChapterFlagKeys(input.allKeys, {
      bookId: input.bookId,
      sectionIndex: section,
      targetLang: input.targetLang,
      providerId: input.providerId,
    });
    const complete = flags.some((key) => input.flagValues.get(key) === "1");
    if (complete) {
      out.set(section, "TRANSLATED");
      continue;
    }
    if (input.failedSections?.has(section)) {
      out.set(section, "ERROR");
      continue;
    }
    if (input.activeSections?.has(section)) {
      out.set(section, "TRANSLATING");
      continue;
    }
    const paraKeys = matchParagraphKeysForChapter(input.allKeys, {
      bookId: input.bookId,
      chapterId: String(section),
      chapterHref: chapter.href,
      provider: input.providerId,
      targetLang: input.targetLang,
    });
    out.set(section, paraKeys.length > 0 ? "PARTIAL" : "NOT_TRANSLATED");
  }
  return out;
}

function sanitizeRecordPart(value: string, maxLen = 48): string {
  return (value || "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, maxLen);
}

function chapterTitlesKey(bookId: string, targetLang: string, providerId?: string): string {
  const parts = [
    "readany_chapter_titles",
    sanitizeRecordPart(bookId),
    sanitizeRecordPart(targetLang, 16),
  ];
  if (providerId) parts.push(sanitizeRecordPart(providerId, 24));
  return parts.join("_");
}

/** Read all translated titles for one book+language+provider (single KV read). */
export async function getTranslatedChapterTitles(
  bookId: string,
  targetLang: string,
  providerId?: string,
): Promise<Record<number, string>> {
  try {
    const platform = getPlatformService();
    const raw = await platform.kvGetItem(chapterTitlesKey(bookId, targetLang, providerId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as { titles?: Record<string, string> };
    const out: Record<number, string> = {};
    for (const [key, value] of Object.entries(parsed.titles ?? {})) {
      const section = Number(key);
      if (Number.isInteger(section) && typeof value === "string" && value) {
        out[section] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Persist one translated title (read-modify-write of the single record). */
export async function setTranslatedChapterTitle(
  bookId: string,
  sectionIndex: number,
  title: string,
  targetLang: string,
  providerId?: string,
): Promise<void> {
  if (!title) return;
  try {
    const platform = getPlatformService();
    const key = chapterTitlesKey(bookId, targetLang, providerId);
    const raw = await platform.kvGetItem(key);
    let titles: Record<string, string> = {};
    if (raw) {
      try {
        titles = (JSON.parse(raw) as { titles?: Record<string, string> }).titles ?? {};
      } catch {
        titles = {};
      }
    }
    titles[String(sectionIndex)] = title;
    await platform.kvSetItem(key, JSON.stringify({ version: 1, titles }));
  } catch (err) {
    console.warn("[Translation] Failed to store chapter title:", err);
  }
}

/**
 * Map an EPUB CFI to its spine section index. Foliate generates section CFIs
 * as `epubcfi(/6/<(index+1)*2>!...)`, so the inverse is `N / 2 - 1`.
 * Returns null for unparseable CFIs (e.g. PDF `page-N` markers).
 */
export function sectionIndexFromCfi(cfi: string | null | undefined): number | null {
  if (!cfi || typeof cfi !== "string") return null;
  const match = /^epubcfi\(\/6\/(\d+)!/.exec(cfi.trim());
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isInteger(n) || n < 2 || n % 2 !== 0) return null;
  return n / 2 - 1;
}

export type ChapterSortOrder = "asc" | "desc";
export type ChapterStatusFilter = "all" | "translated" | "not_translated";

/** Presentation-only sort (never mutates identity or order semantics). */
export function sortOverviewChapters(
  chapters: OverviewChapterRef[],
  order: ChapterSortOrder,
): OverviewChapterRef[] {
  const sorted = [...chapters].sort((a, b) => a.sectionIndex - b.sectionIndex);
  return order === "desc" ? sorted.reverse() : sorted;
}

/** Presentation-only filter by derived status. */
export function filterOverviewChapters(
  chapters: OverviewChapterRef[],
  statuses: Map<number, ChapterTranslationStatus>,
  filter: ChapterStatusFilter,
): OverviewChapterRef[] {
  if (filter === "all") return chapters;
  return chapters.filter((chapter) => {
    const status = statuses.get(chapter.sectionIndex) ?? "NOT_TRANSLATED";
    return filter === "translated" ? status === "TRANSLATED" : status !== "TRANSLATED";
  });
}

export type LibraryTapAction =
  | { kind: "overview"; bookId: string }
  | { kind: "download"; bookId: string }
  | { kind: "blocked"; reason: "downloading" | "deleted" };

/**
 * Pure routing decision for a library single-tap (test A). Deep links
 * (notes, chat) keep using the direct-reader opener; only the library grid
 * routes through the overview.
 */
export function resolveLibraryTapAction(book: {
  id: string;
  syncStatus: "local" | "remote" | "downloading";
  deletedAt?: number;
}): LibraryTapAction {
  if (book.syncStatus === "downloading") return { kind: "blocked", reason: "downloading" };
  if (book.deletedAt) return { kind: "blocked", reason: "deleted" };
  if (book.syncStatus === "remote") return { kind: "download", bookId: book.id };
  return { kind: "overview", bookId: book.id };
}

export interface ReaderChapterParams {
  bookId: string;
  href?: string;
  cfi?: string;
  highlight?: boolean;
  openSearch?: boolean;
}

/** Chapter tap → Reader at that chapter via stable href (test D). */
export function buildReaderParamsForChapter(
  bookId: string,
  chapter: Pick<OverviewChapterRef, "href">,
): ReaderChapterParams {
  return { bookId, href: chapter.href || undefined };
}

/** Continue Reading → Reader at the saved CFI (test E). */
export function buildReaderParamsForContinue(
  bookId: string,
  currentCfi?: string,
): ReaderChapterParams {
  return { bookId, cfi: currentCfi || undefined };
}

/** Note/highlight tap → Reader at the annotation CFI (test V). */
export function buildReaderParamsForAnnotation(bookId: string, cfi: string): ReaderChapterParams {
  return { bookId, cfi, highlight: true };
}

/** Overview search entry → Reader with the search panel open (test T). */
export function buildReaderParamsForSearch(bookId: string): ReaderChapterParams {
  return { bookId, openSearch: true };
}
