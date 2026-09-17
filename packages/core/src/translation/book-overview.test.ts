import { beforeEach, describe, expect, it } from "vitest";
import { type IPlatformService, setPlatformService } from "../services/platform";
import {
  type OverviewChapterRef,
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
} from "./book-overview";
import { storeInCache } from "./cache";
import { markChapterFullyCached } from "./chapter-cache";

function createFakePlatform() {
  const kv = new Map<string, string>();
  return {
    store: kv,
    service: {
      kvGetItem: async (key: string) => (kv.has(key) ? (kv.get(key) as string) : null),
      kvSetItem: async (key: string, value: string) => {
        kv.set(key, value);
      },
      kvRemoveItem: async (key: string) => {
        kv.delete(key);
      },
      kvGetAllKeys: async () => [...kv.keys()],
    } as unknown as IPlatformService,
  };
}

const CHAPTERS: OverviewChapterRef[] = [
  { sectionIndex: 0, href: "Text/cover.xhtml", title: "Cover" },
  { sectionIndex: 1, href: "Text/ch01.xhtml", title: "Chapter 1" },
  { sectionIndex: 2, href: "Text/ch02.xhtml", title: "Chapter 2" },
  { sectionIndex: 3, href: "Text/ch03.xhtml", title: "Chapter 3" },
];

const BOOK = "book-1";
const LANG = "id";
const PROVIDER = "ai";

async function markComplete(section: number, sourceHash = "hash-1") {
  await markChapterFullyCached(BOOK, section, LANG, {
    chapterId: String(section),
    chapterHref: CHAPTERS[section]?.href,
    sourceHash,
    sourceLang: "AUTO",
    providerId: PROVIDER,
    verification: { expectedCount: 2, actualCount: 2, hasEmpty: false },
  });
}

async function deriveAllKeys(service: IPlatformService) {
  const keys = await service.kvGetAllKeys();
  const values = new Map<string, string>();
  for (const key of keys) {
    const value = await service.kvGetItem(key);
    if (value != null) values.set(key, value);
  }
  return { keys, values };
}

describe("deriveChapterStatuses (tests H, M)", () => {
  let fake: ReturnType<typeof createFakePlatform>;

  beforeEach(() => {
    fake = createFakePlatform();
    setPlatformService(fake.service);
  });

  it("marks untouched chapters NOT_TRANSLATED", async () => {
    const { keys, values } = await deriveAllKeys(fake.service);
    const statuses = deriveChapterStatuses({
      chapters: CHAPTERS,
      bookId: BOOK,
      targetLang: LANG,
      providerId: PROVIDER,
      allKeys: keys,
      flagValues: values,
    });
    for (const chapter of CHAPTERS) {
      expect(statuses.get(chapter.sectionIndex)).toBe("NOT_TRANSLATED");
    }
  });

  it("marks chapters with a complete flag TRANSLATED", async () => {
    await markComplete(1);
    await markComplete(2);
    const { keys, values } = await deriveAllKeys(fake.service);
    const statuses = deriveChapterStatuses({
      chapters: CHAPTERS,
      bookId: BOOK,
      targetLang: LANG,
      providerId: PROVIDER,
      allKeys: keys,
      flagValues: values,
    });
    expect(statuses.get(0)).toBe("NOT_TRANSLATED");
    expect(statuses.get(1)).toBe("TRANSLATED");
    expect(statuses.get(2)).toBe("TRANSLATED");
    expect(statuses.get(3)).toBe("NOT_TRANSLATED");
  });

  it("isolates providers: another provider's flag does not count (test M)", async () => {
    await markComplete(1);
    const { keys, values } = await deriveAllKeys(fake.service);
    const statuses = deriveChapterStatuses({
      chapters: CHAPTERS,
      bookId: BOOK,
      targetLang: LANG,
      providerId: "microsoft",
      allKeys: keys,
      flagValues: values,
    });
    expect(statuses.get(1)).not.toBe("TRANSLATED");
  });

  it("marks chapters with only paragraph entries PARTIAL", async () => {
    await storeInCache("some sentence", "terjemahan", "AUTO", LANG, "ai", {
      bookId: BOOK,
      chapterId: "3",
      chapterHref: "Text/ch03.xhtml",
      sourceHash: "hash-9",
    });
    const { keys, values } = await deriveAllKeys(fake.service);
    const statuses = deriveChapterStatuses({
      chapters: CHAPTERS,
      bookId: BOOK,
      targetLang: LANG,
      providerId: PROVIDER,
      allKeys: keys,
      flagValues: values,
    });
    expect(statuses.get(3)).toBe("PARTIAL");
  });

  it("prioritizes ERROR and TRANSLATING over partial data", async () => {
    await storeInCache("s", "t", "AUTO", LANG, "ai", {
      bookId: BOOK,
      chapterId: "1",
      sourceHash: "h",
    });
    const { keys, values } = await deriveAllKeys(fake.service);
    const base = {
      chapters: CHAPTERS,
      bookId: BOOK,
      targetLang: LANG,
      providerId: PROVIDER,
      allKeys: keys,
      flagValues: values,
    };
    expect(deriveChapterStatuses({ ...base, failedSections: new Set([1]) }).get(1)).toBe("ERROR");
    expect(deriveChapterStatuses({ ...base, activeSections: new Set([1]) }).get(1)).toBe(
      "TRANSLATING",
    );
  });
});

describe("translated chapter titles (test I)", () => {
  beforeEach(() => {
    setPlatformService(createFakePlatform().service);
  });

  it("round-trips titles with original fallback", async () => {
    expect(await getTranslatedChapterTitles(BOOK, LANG, PROVIDER)).toEqual({});
    await setTranslatedChapterTitle(BOOK, 1, "Bab 1: Awal", LANG, PROVIDER);
    await setTranslatedChapterTitle(BOOK, 2, "Bab 2", LANG, PROVIDER);
    const titles = await getTranslatedChapterTitles(BOOK, LANG, PROVIDER);
    expect(titles[1]).toBe("Bab 1: Awal");
    expect(titles[2]).toBe("Bab 2");
    // Other providers/languages are isolated.
    expect(await getTranslatedChapterTitles(BOOK, LANG, "microsoft")).toEqual({});
    expect(await getTranslatedChapterTitles(BOOK, "en", PROVIDER)).toEqual({});
  });

  it("ignores empty titles", async () => {
    await setTranslatedChapterTitle(BOOK, 1, "", LANG, PROVIDER);
    expect(await getTranslatedChapterTitles(BOOK, LANG, PROVIDER)).toEqual({});
  });
});

describe("sectionIndexFromCfi (test E support)", () => {
  it("inverts foliate section CFIs", () => {
    expect(sectionIndexFromCfi("epubcfi(/6/2!)")).toBe(0);
    expect(sectionIndexFromCfi("epubcfi(/6/4!/4/2/1:0)")).toBe(1);
    expect(sectionIndexFromCfi("epubcfi(/6/360!)")).toBe(179);
  });
  it("returns null for non-section CFIs", () => {
    expect(sectionIndexFromCfi(null)).toBeNull();
    expect(sectionIndexFromCfi("")).toBeNull();
    expect(sectionIndexFromCfi("page-5")).toBeNull();
    expect(sectionIndexFromCfi("epubcfi(/6/3!)")).toBeNull();
    expect(sectionIndexFromCfi("garbage")).toBeNull();
  });
});

describe("sort + filter (presentation only)", () => {
  it("sorts without mutating identity", () => {
    const asc = sortOverviewChapters(CHAPTERS, "asc");
    const desc = sortOverviewChapters(CHAPTERS, "desc");
    expect(asc.map((c) => c.sectionIndex)).toEqual([0, 1, 2, 3]);
    expect(desc.map((c) => c.sectionIndex)).toEqual([3, 2, 1, 0]);
    expect(CHAPTERS[0]?.sectionIndex).toBe(0);
  });

  it("filters by derived status", async () => {
    setPlatformService(createFakePlatform().service);
    await markComplete(1);
    const platform = (await import("../services/platform")).getPlatformService();
    const keys = await platform.kvGetAllKeys();
    const values = new Map<string, string>();
    for (const key of keys) {
      const value = await platform.kvGetItem(key);
      if (value != null) values.set(key, value);
    }
    const statuses = deriveChapterStatuses({
      chapters: CHAPTERS,
      bookId: BOOK,
      targetLang: LANG,
      providerId: PROVIDER,
      allKeys: keys,
      flagValues: values,
    });
    expect(filterOverviewChapters(CHAPTERS, statuses, "all")).toHaveLength(4);
    expect(
      filterOverviewChapters(CHAPTERS, statuses, "translated").map((c) => c.sectionIndex),
    ).toEqual([1]);
    expect(
      filterOverviewChapters(CHAPTERS, statuses, "not_translated").map((c) => c.sectionIndex),
    ).toEqual([0, 2, 3]);
  });
});

describe("navigation builders (tests A, D, E, V, T)", () => {
  it("resolves library single-tap routing (test A)", () => {
    expect(resolveLibraryTapAction({ id: "b", syncStatus: "local" })).toEqual({
      kind: "overview",
      bookId: "b",
    });
    expect(resolveLibraryTapAction({ id: "b", syncStatus: "remote" })).toEqual({
      kind: "download",
      bookId: "b",
    });
    expect(resolveLibraryTapAction({ id: "b", syncStatus: "downloading" })).toEqual({
      kind: "blocked",
      reason: "downloading",
    });
    expect(resolveLibraryTapAction({ id: "b", syncStatus: "local", deletedAt: 1 })).toEqual({
      kind: "blocked",
      reason: "deleted",
    });
  });

  it("builds stable reader params (tests D, E, V, T)", () => {
    expect(buildReaderParamsForChapter("b", { href: "Text/ch02.xhtml" })).toEqual({
      bookId: "b",
      href: "Text/ch02.xhtml",
    });
    expect(buildReaderParamsForContinue("b", "epubcfi(/6/4!)")).toEqual({
      bookId: "b",
      cfi: "epubcfi(/6/4!)",
    });
    expect(buildReaderParamsForContinue("b")).toEqual({ bookId: "b", cfi: undefined });
    expect(buildReaderParamsForAnnotation("b", "epubcfi(/6/4!/2)")).toEqual({
      bookId: "b",
      cfi: "epubcfi(/6/4!/2)",
      highlight: true,
    });
    expect(buildReaderParamsForSearch("b")).toEqual({ bookId: "b", openSearch: true });
  });
});

describe("source hash validation (test N)", () => {
  it("demotes stale flags when source text changes", async () => {
    setPlatformService(createFakePlatform().service);
    const { hashSourceTexts } = await import("./cache");
    const { isChapterFullyCached } = await import("./chapter-cache");
    const before = hashSourceTexts(["a", "b"]);
    const after = hashSourceTexts(["a", "CHANGED"]);
    expect(before).not.toBe(after);
    await markChapterFullyCached(BOOK, 1, LANG, {
      chapterId: "1",
      chapterHref: "Text/ch01.xhtml",
      sourceHash: before,
      sourceLang: "AUTO",
      providerId: PROVIDER,
      verification: { expectedCount: 1, actualCount: 1, hasEmpty: false },
    });
    const identity = {
      chapterId: "1",
      chapterHref: "Text/ch01.xhtml",
      sourceLang: "AUTO",
      providerId: PROVIDER,
    };
    expect(await isChapterFullyCached(BOOK, 1, LANG, { ...identity, sourceHash: before })).toBe(
      true,
    );
    expect(await isChapterFullyCached(BOOK, 1, LANG, { ...identity, sourceHash: after })).toBe(
      false,
    );
  });
});
