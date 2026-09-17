import { beforeEach, describe, expect, it, vi } from "vitest";
import { type IPlatformService, setPlatformService } from "../services/platform";
import type { TranslationConfig } from "../types/translation";
import type { OverviewChapterRef } from "./book-overview";
import {
  type BookQueueEvent,
  computeResumePending,
  createBookTranslationTask,
  loadBookTranslationTask,
  planBookTranslationScope,
  runBookTranslationQueue,
  saveBookTranslationTask,
} from "./book-translation-queue";
import type { ChapterParagraph } from "./chapter-translator";

function createFakePlatform() {
  const kv = new Map<string, string>();
  const service = {
    kvGetItem: async (key: string) => (kv.has(key) ? (kv.get(key) as string) : null),
    kvSetItem: async (key: string, value: string) => {
      kv.set(key, value);
    },
    kvRemoveItem: async (key: string) => {
      kv.delete(key);
    },
    kvGetAllKeys: async () => [...kv.keys()],
  } as unknown as IPlatformService;
  return { kv, service };
}

const CHAPTERS: OverviewChapterRef[] = [
  { sectionIndex: 0, href: "Text/c0.xhtml", title: "Cover" },
  { sectionIndex: 1, href: "Text/c1.xhtml", title: "One" },
  { sectionIndex: 2, href: "Text/c2.xhtml", title: "Two" },
];

const CONFIG = {
  provider: { id: "ai" },
  targetLang: "id",
} as unknown as TranslationConfig;
function parasFor(section: number): ChapterParagraph[] {
  return [
    { id: "para_0", text: `chapter ${section} first`, tagName: "p" },
    { id: "para_1", text: `chapter ${section} second`, tagName: "p" },
  ];
}

describe("planBookTranslationScope (tests F, G)", () => {
  it("overview Translate covers every chapter; reader covers one", () => {
    expect(planBookTranslationScope(CHAPTERS, { mode: "all" })).toHaveLength(3);
    expect(planBookTranslationScope(CHAPTERS, { mode: "single", sectionIndex: 2 })).toEqual([
      CHAPTERS[2],
    ]);
  });
});

describe("computeResumePending (tests J, K)", () => {
  it("skips done sections and live-complete chapters", () => {
    const task = createBookTranslationTask({
      bookId: "b",
      targetLang: "id",
      providerId: "ai",
      sourceLang: "AUTO",
      totalChapters: 3,
    });
    task.doneSections = [0];
    const pending = computeResumePending(CHAPTERS, task, (s) => s === 2);
    expect(pending.map((c) => c.sectionIndex)).toEqual([1]);
  });

  it("returns everything without a task", () => {
    expect(computeResumePending(CHAPTERS, null, () => false)).toHaveLength(3);
  });
});

describe("task persistence (test O)", () => {
  beforeEach(() => {
    setPlatformService(createFakePlatform().service);
  });

  it("round-trips the task record (crash recovery shape)", async () => {
    expect(await loadBookTranslationTask("b")).toBeNull();
    const task = createBookTranslationTask({
      bookId: "b",
      targetLang: "id",
      providerId: "ai",
      sourceLang: "AUTO",
      totalChapters: 3,
    });
    task.doneSections = [0, 1];
    task.failedSections = { 2: "boom" };
    await saveBookTranslationTask(task);
    const loaded = await loadBookTranslationTask("b");
    expect(loaded?.doneSections).toEqual([0, 1]);
    expect(loaded?.failedSections).toEqual({ 2: "boom" });
    expect(await loadBookTranslationTask("other")).toBeNull();
  });
});

describe("runBookTranslationQueue (tests J, K, L, O)", () => {
  beforeEach(() => {
    setPlatformService(createFakePlatform().service);
  });

  function baseDeps(events: BookQueueEvent[] = []) {
    return {
      extractChapterParagraphs: async (chapter: OverviewChapterRef) =>
        parasFor(chapter.sectionIndex),
      translateChapterFn: (async (options: {
        paragraphs: ChapterParagraph[];
      }) => {
        await new Promise((r) => setTimeout(r, 0));
        return options.paragraphs.map((p) => ({
          paragraphId: p.id,
          originalText: p.text,
          translatedText: `ID:${p.text}`,
        }));
      }) as never,
      translateTitle: async (title: string) => `ID:${title}`,
      onEvent: (event: BookQueueEvent) => {
        events.push(event);
      },
    };
  }

  it("translates every chapter, stores titles, completes the task", async () => {
    const events: BookQueueEvent[] = [];
    const task = await runBookTranslationQueue({
      bookId: "b",
      chapters: CHAPTERS,
      targetLang: "id",
      providerId: "ai",
      config: CONFIG,
      deps: baseDeps(events),
    });
    expect(task.status).toBe("complete");
    expect(task.doneSections).toEqual([0, 1, 2]);
    expect(task.failedSections).toEqual({});
    expect(events.filter((e) => e.type === "chapter-done")).toHaveLength(3);
    // Crash recovery: persisted task reloads complete.
    const reloaded = await loadBookTranslationTask("b");
    expect(reloaded?.status).toBe("complete");
    expect(reloaded?.doneSections).toEqual([0, 1, 2]);
  });

  it("resume skips done chapters and never re-translates them (test K)", async () => {
    const calls: number[] = [];
    const first = await runBookTranslationQueue({
      bookId: "b",
      chapters: CHAPTERS.slice(0, 2),
      targetLang: "id",
      providerId: "ai",
      config: CONFIG,
      deps: {
        ...baseDeps(),
        translateChapterFn: (async (options: { paragraphs: ChapterParagraph[] }) => {
          calls.push(1);
          return options.paragraphs.map((p) => ({
            paragraphId: p.id,
            originalText: p.text,
            translatedText: `ID:${p.text}`,
          }));
        }) as never,
      },
    });
    expect(first.doneSections).toEqual([0, 1]);
    calls.length = 0;
    const resumed = await runBookTranslationQueue({
      bookId: "b",
      chapters: CHAPTERS,
      targetLang: "id",
      providerId: "ai",
      config: CONFIG,
      resumeTask: first,
      deps: {
        ...baseDeps(),
        translateChapterFn: (async (options: { paragraphs: ChapterParagraph[] }) => {
          calls.push(1);
          return options.paragraphs.map((p) => ({
            paragraphId: p.id,
            originalText: p.text,
            translatedText: `ID:${p.text}`,
          }));
        }) as never,
      },
    });
    // Only section 2 was translated in the resumed run (0,1 skipped).
    expect(calls).toHaveLength(1);
    expect(resumed.doneSections).toEqual([0, 1, 2]);
  });

  it("partial results never mark complete (test L) and failures do not block others", async () => {
    const deps = baseDeps();
    const flaky = {
      ...deps,
      translateChapterFn: (async (options: {
        paragraphs: ChapterParagraph[];
        identity?: { chapterId?: string };
      }) => {
        // Section 1 fails hard; section 2 returns a partial (empty) result.
        const id = options.identity?.chapterId;
        if (id === "1") throw new Error("provider down");
        return options.paragraphs.map((p, i) => ({
          paragraphId: p.id,
          originalText: p.text,
          translatedText: id === "2" && i === 0 ? "" : `ID:${p.text}`,
        }));
      }) as never,
    };
    const task = await runBookTranslationQueue({
      bookId: "b",
      chapters: CHAPTERS,
      targetLang: "id",
      providerId: "ai",
      config: CONFIG,
      deps: flaky,
    });
    expect(task.status).toBe("error");
    expect(task.doneSections).toEqual([0]);
    expect(Object.keys(task.failedSections).sort()).toEqual(["1", "2"]);
    // Section 0 still completed despite siblings failing.
    const { isChapterFullyCached } = await import("./chapter-cache");
    const { hashSourceTexts } = await import("./cache");
    const sourceHash = hashSourceTexts(parasFor(0).map((p) => p.text));
    expect(
      await isChapterFullyCached("b", 0, "id", {
        chapterId: "0",
        chapterHref: "Text/c0.xhtml",
        sourceHash,
        sourceLang: "AUTO",
        providerId: "ai",
      }),
    ).toBe(true);
  });

  it("abort pauses safely with progress persisted", async () => {
    const controller = new AbortController();
    const deps = baseDeps();
    const slow = {
      ...deps,
      extractChapterParagraphs: async (chapter: OverviewChapterRef) => {
        if (chapter.sectionIndex >= 1) controller.abort();
        return parasFor(chapter.sectionIndex);
      },
    };
    const task = await runBookTranslationQueue({
      bookId: "b",
      chapters: CHAPTERS,
      targetLang: "id",
      providerId: "ai",
      config: CONFIG,
      signal: controller.signal,
      deps: slow,
    });
    expect(task.status).toBe("paused");
    expect(task.doneSections).toEqual([0]);
    const reloaded = await loadBookTranslationTask("b");
    expect(reloaded?.status).toBe("paused");
    expect(reloaded?.doneSections).toEqual([0]);
  });

  it("title failure never fails the chapter (test I)", async () => {
    const deps = baseDeps();
    const task = await runBookTranslationQueue({
      bookId: "b",
      chapters: CHAPTERS.slice(0, 1),
      targetLang: "id",
      providerId: "ai",
      config: CONFIG,
      deps: {
        ...deps,
        translateTitle: async () => {
          throw new Error("title failed");
        },
      },
    });
    expect(task.status).toBe("complete");
    expect(task.doneSections).toEqual([0]);
  });

  it("skips chapters already complete outside the queue", async () => {
    const { markChapterFullyCached } = await import("./chapter-cache");
    const { hashSourceTexts } = await import("./cache");
    const sourceHash = hashSourceTexts(parasFor(1).map((p) => p.text));
    await markChapterFullyCached("b", 1, "id", {
      chapterId: "1",
      chapterHref: "Text/c1.xhtml",
      sourceHash,
      sourceLang: "AUTO",
      providerId: "ai",
      verification: { expectedCount: 2, actualCount: 2, hasEmpty: false },
    });
    const translateSpy = vi.fn(async (options: { paragraphs: ChapterParagraph[] }) =>
      options.paragraphs.map((p) => ({
        paragraphId: p.id,
        originalText: p.text,
        translatedText: `ID:${p.text}`,
      })),
    );
    const task = await runBookTranslationQueue({
      bookId: "b",
      chapters: CHAPTERS.slice(0, 2),
      targetLang: "id",
      providerId: "ai",
      config: CONFIG,
      deps: { ...baseDeps(), translateChapterFn: translateSpy as never },
    });
    expect(translateSpy).toHaveBeenCalledTimes(1);
    expect(task.doneSections).toEqual([0, 1]);
  });
});
