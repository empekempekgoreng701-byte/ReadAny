/**
 * Full-book translation queue (Book Overview → Translate).
 *
 * Architecture (adapted from NoveLA's DownloadManager task model):
 * - ONE persistent task record per book (KV): chapter scope, done/failed
 *   sections, status. Saved after EVERY chapter → crash-safe resume.
 * - Chapters run SEQUENTIALLY (concurrency 1 at chapter level; chunk-level
 *   concurrency stays inside `translateChapter`). Memory holds one chapter's
 *   paragraphs at a time — never the whole book.
 * - Chapters completed outside the queue (e.g. in the reader) are skipped via
 *   a strict complete-flag check once the chapter text is extracted.
 * - A failed chapter never blocks or deletes the others (failed map in task).
 * - Abort is safe between chapters; the task persists as paused.
 */

import { getPlatformService } from "../services/platform";
import type { AIConfig } from "../types/chat";
import type { TranslationConfig } from "../types/translation";
import type { OverviewChapterRef } from "./book-overview";
import { setTranslatedChapterTitle } from "./book-overview";
import { hashSourceTexts } from "./cache";
import { isChapterFullyCached, markChapterFullyCached } from "./chapter-cache";
import {
  type ChapterParagraph,
  type ChapterTranslationProgress,
  translateChapter,
} from "./chapter-translator";

export type BookTranslationTaskStatus = "running" | "paused" | "complete" | "error";

export interface BookTranslationTaskRecord {
  version: 1;
  bookId: string;
  targetLang: string;
  providerId: string;
  sourceLang: string;
  totalChapters: number;
  doneSections: number[];
  failedSections: Record<number, string>;
  status: BookTranslationTaskStatus;
  updatedAt: number;
}

export function bookTranslationTaskKey(bookId: string): string {
  const safe = (bookId || "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
  return `readany_book_translation_task_${safe}`;
}

export async function loadBookTranslationTask(
  bookId: string,
): Promise<BookTranslationTaskRecord | null> {
  try {
    const platform = getPlatformService();
    const raw = await platform.kvGetItem(bookTranslationTaskKey(bookId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as BookTranslationTaskRecord;
    if (!parsed || parsed.version !== 1 || parsed.bookId !== bookId) return null;
    return {
      ...parsed,
      doneSections: Array.isArray(parsed.doneSections) ? parsed.doneSections : [],
      failedSections:
        parsed.failedSections && typeof parsed.failedSections === "object"
          ? parsed.failedSections
          : {},
    };
  } catch {
    return null;
  }
}

export async function saveBookTranslationTask(task: BookTranslationTaskRecord): Promise<void> {
  try {
    const platform = getPlatformService();
    await platform.kvSetItem(
      bookTranslationTaskKey(task.bookId),
      JSON.stringify({ ...task, updatedAt: Date.now() }),
    );
  } catch (err) {
    console.warn("[Translation] Failed to persist book translation task:", err);
  }
}

export function createBookTranslationTask(options: {
  bookId: string;
  targetLang: string;
  providerId: string;
  sourceLang: string;
  totalChapters: number;
}): BookTranslationTaskRecord {
  return {
    version: 1,
    bookId: options.bookId,
    targetLang: options.targetLang,
    providerId: options.providerId,
    sourceLang: options.sourceLang,
    totalChapters: options.totalChapters,
    doneSections: [],
    failedSections: {},
    status: "running",
    updatedAt: Date.now(),
  };
}

/**
 * Chapters still needing work: drops done sections AND currently-complete
 * chapters (test K). Never mutates the task.
 */
export function computeResumePending(
  chapters: OverviewChapterRef[],
  task: Pick<BookTranslationTaskRecord, "doneSections"> | null,
  isComplete: (sectionIndex: number) => boolean,
): OverviewChapterRef[] {
  const done = new Set(task?.doneSections ?? []);
  return chapters.filter((chapter) => {
    if (done.has(chapter.sectionIndex)) return false;
    if (isComplete(chapter.sectionIndex)) return false;
    return true;
  });
}

export type BookTranslationScope = { mode: "all" } | { mode: "single"; sectionIndex: number };

/**
 * Queue scope planner (tests F/G): overview Translate = every chapter,
 * reader Translate = only the current chapter. Pure.
 */
export function planBookTranslationScope(
  chapters: OverviewChapterRef[],
  scope: BookTranslationScope,
): OverviewChapterRef[] {
  if (scope.mode === "single") {
    return chapters.filter((chapter) => chapter.sectionIndex === scope.sectionIndex);
  }
  return [...chapters];
}

/** Mirror of the reader hook's AI-endpoint resolution (single-sourced here for the queue). */
export function resolveEffectiveTranslationConfig(
  translationConfig: TranslationConfig,
  aiConfig: AIConfig,
  overrideTargetLang?: string,
): TranslationConfig {
  const config: TranslationConfig = { ...translationConfig };
  if (overrideTargetLang) {
    config.targetLang = overrideTargetLang as typeof config.targetLang;
  }
  if (config.provider.id === "ai") {
    const endpointId = config.provider.endpointId || aiConfig.activeEndpointId;
    const endpoint = aiConfig.endpoints.find((e) => e.id === endpointId);
    if (endpoint) {
      config.provider = {
        ...config.provider,
        apiKey: endpoint.apiKey,
        baseUrl: endpoint.baseUrl,
        useExactRequestUrl: endpoint.useExactRequestUrl,
        model: config.provider.model || aiConfig.activeModel,
      };
    }
  }
  return config;
}

export type BookQueueEvent =
  | { type: "chapter-start"; sectionIndex: number; title: string }
  | {
      type: "chapter-progress";
      sectionIndex: number;
      progress: ChapterTranslationProgress;
    }
  | { type: "chapter-done"; sectionIndex: number }
  | { type: "chapter-failed"; sectionIndex: number; error: string }
  | { type: "task-progress"; done: number; total: number }
  | { type: "task-done"; done: number; failed: number }
  | { type: "task-aborted"; done: number };

export interface BookQueueDeps {
  /** Extract one chapter's paragraphs (bounded: caller releases memory after). */
  extractChapterParagraphs: (chapter: OverviewChapterRef) => Promise<ChapterParagraph[]>;
  /** Chapter translator (injectable for tests). */
  translateChapterFn?: typeof translateChapter;
  /** Single-text translation for chapter titles (best-effort, non-fatal). */
  translateTitle?: (title: string) => Promise<string>;
  onEvent?: (event: BookQueueEvent) => void;
  /** Per-chapter yield so the UI thread breathes on huge books. */
  yieldBetweenChapters?: () => Promise<void>;
}

export interface RunBookTranslationOptions {
  bookId: string;
  chapters: OverviewChapterRef[];
  targetLang: string;
  providerId: string;
  sourceLang?: string;
  /** Resume from this persisted task when it matches lang+provider. */
  resumeTask?: BookTranslationTaskRecord | null;
  signal?: AbortSignal;
  deps: BookQueueDeps;
  config: TranslationConfig;
}

const defaultYield = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Run full-book translation sequentially with per-chapter persistence.
 * Resolves when the queue drains, aborts, or fatally fails to start.
 */
export async function runBookTranslationQueue(
  options: RunBookTranslationOptions,
): Promise<BookTranslationTaskRecord> {
  const { bookId, chapters, targetLang, providerId, signal, deps, config } = options;
  const sourceLang = options.sourceLang ?? "AUTO";
  const translateFn = deps.translateChapterFn ?? translateChapter;
  const yieldFn = deps.yieldBetweenChapters ?? defaultYield;

  const previous = options.resumeTask;
  const reusePrevious =
    previous &&
    previous.bookId === bookId &&
    previous.targetLang === targetLang &&
    previous.providerId === providerId;
  const task = reusePrevious
    ? {
        ...previous,
        doneSections: [...previous.doneSections],
        failedSections: { ...previous.failedSections },
        status: "running" as const,
        totalChapters: chapters.length,
      }
    : createBookTranslationTask({
        bookId,
        targetLang,
        providerId,
        sourceLang,
        totalChapters: chapters.length,
      });

  const isAborted = () => signal?.aborted ?? false;
  const emit = (event: BookQueueEvent) => {
    try {
      deps.onEvent?.(event);
    } catch {
      // Listener errors must never break the queue.
    }
  };
  const persist = async () => {
    await saveBookTranslationTask(task);
  };

  for (const chapter of chapters) {
    if (isAborted()) {
      task.status = "paused";
      await persist();
      emit({ type: "task-aborted", done: task.doneSections.length });
      return task;
    }
    if (task.doneSections.includes(chapter.sectionIndex)) continue;

    emit({ type: "chapter-start", sectionIndex: chapter.sectionIndex, title: chapter.title });

    try {
      const paragraphs = await deps.extractChapterParagraphs(chapter);
      if (isAborted()) {
        task.status = "paused";
        await persist();
        emit({ type: "task-aborted", done: task.doneSections.length });
        return task;
      }
      if (!paragraphs || paragraphs.length === 0) {
        throw new Error("empty-chapter");
      }
      const sourceHash = hashSourceTexts(paragraphs.map((p) => p.text));
      const identity = {
        bookId,
        chapterId: String(chapter.sectionIndex),
        chapterHref: chapter.href || undefined,
        sourceHash,
      };
      // Skip chapters already complete outside the queue (e.g. in the reader).
      const alreadyComplete = await isChapterFullyCached(bookId, chapter.sectionIndex, targetLang, {
        ...identity,
        sourceLang,
        providerId,
      });
      if (alreadyComplete) {
        task.doneSections.push(chapter.sectionIndex);
        delete task.failedSections[chapter.sectionIndex];
        await persist();
        emit({ type: "chapter-done", sectionIndex: chapter.sectionIndex });
        emit({ type: "task-progress", done: task.doneSections.length, total: task.totalChapters });
        continue;
      }

      const results = await translateFn({
        paragraphs,
        sourceLang,
        targetLang,
        config,
        identity,
        onProgress: (progress) =>
          emit({ type: "chapter-progress", sectionIndex: chapter.sectionIndex, progress }),
        signal,
      });
      if (isAborted()) {
        task.status = "paused";
        await persist();
        emit({ type: "task-aborted", done: task.doneSections.length });
        return task;
      }

      // Verification gate (test L): partial results must NOT mark complete.
      const hasEmpty = results.some((r) => !r.translatedText);
      const marked = await markChapterFullyCached(bookId, chapter.sectionIndex, targetLang, {
        ...identity,
        sourceLang,
        providerId,
        verification: {
          expectedCount: paragraphs.length,
          actualCount: results.length,
          hasEmpty,
        },
      });
      if (!marked) {
        throw new Error("incomplete-result");
      }

      // Translated title: best-effort, never fails the chapter (test I).
      try {
        if (deps.translateTitle && chapter.title) {
          const translatedTitle = await deps.translateTitle(chapter.title);
          if (translatedTitle) {
            await setTranslatedChapterTitle(
              bookId,
              chapter.sectionIndex,
              translatedTitle,
              targetLang,
              providerId,
            );
          }
        }
      } catch {
        // Title failure is non-fatal; the chapter itself is complete.
      }

      task.doneSections.push(chapter.sectionIndex);
      delete task.failedSections[chapter.sectionIndex];
      await persist();
      emit({ type: "chapter-done", sectionIndex: chapter.sectionIndex });
      emit({ type: "task-progress", done: task.doneSections.length, total: task.totalChapters });
    } catch (err) {
      if (isAborted() || (err as Error)?.name === "AbortError") {
        task.status = "paused";
        await persist();
        emit({ type: "task-aborted", done: task.doneSections.length });
        return task;
      }
      const message = err instanceof Error ? err.message : String(err);
      task.failedSections[chapter.sectionIndex] = message;
      await persist();
      emit({ type: "chapter-failed", sectionIndex: chapter.sectionIndex, error: message });
      emit({ type: "task-progress", done: task.doneSections.length, total: task.totalChapters });
    }

    await yieldFn();
  }

  const failed = Object.keys(task.failedSections).length;
  task.status = failed > 0 ? "error" : "complete";
  await persist();
  emit({ type: "task-done", done: task.doneSections.length, failed });
  return task;
}
