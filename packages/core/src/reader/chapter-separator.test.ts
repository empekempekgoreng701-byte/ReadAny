import { describe, expect, it } from "vitest";
import {
  CHAPTER_DIVIDER_ATTR,
  CHAPTER_SEPARATOR_STYLE_ID,
  CHAPTER_TITLE_ATTR,
  type SeparatorDocumentLike,
  applyChapterSeparatorToDoc,
  buildChapterSeparatorCss,
  removeChapterSeparatorFromDoc,
  resolveChapterTitle,
  separatorIdentity,
  shouldShowDivider,
} from "./chapter-separator";

/** Minimal fake section document (mirrors the DOM surface the code needs). */
class FakeBody {
  attrs = new Map<string, string>();
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attrs.has(name) ? (this.attrs.get(name) as string) : null;
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }
}

class FakeDoc implements SeparatorDocumentLike {
  body = new FakeBody();
  headChildren: Array<{ id?: string; textContent?: string | null }> = [];
  createdElements = 0;
  head = {
    appendChild: (node: unknown) => {
      this.headChildren.push(node as { id?: string; textContent?: string | null });
    },
  };
  getElementById(id: string): { textContent?: string | null } | null {
    return this.headChildren.find((n) => n.id === id) ?? null;
  }
  createElement(_tag: string): { id?: string; textContent?: string | null } {
    this.createdElements += 1;
    return {};
  }
}

const TOC = [
  { index: 0, href: "cover.xhtml", label: "Cover" },
  {
    index: 1,
    href: "ch01.xhtml",
    label: "Chapter 1:  Beginnings",
    subitems: [{ index: 2, href: "ch01b.xhtml#part2", label: "Chapter 1 (continued)" }],
  },
];

describe("shouldShowDivider", () => {
  it("suppresses the first section, fixed layouts, and disabled contexts", () => {
    expect(shouldShowDivider({ sectionIndex: 0 })).toBe(false);
    expect(shouldShowDivider({ sectionIndex: 1 })).toBe(true);
    expect(shouldShowDivider({ sectionIndex: 2, isFixedLayout: true })).toBe(false);
    expect(shouldShowDivider({ sectionIndex: 2, disabled: true })).toBe(false);
    expect(shouldShowDivider(null)).toBe(false);
  });
});

describe("resolveChapterTitle", () => {
  it("prefers spine-index match, then href, then base href", () => {
    expect(resolveChapterTitle(1, "ch01.xhtml", TOC)).toBe("Chapter 1: Beginnings");
    expect(resolveChapterTitle(9, "ch01b.xhtml#part2", TOC)).toBe("Chapter 1 (continued)");
    expect(resolveChapterTitle(9, "ch01b.xhtml#other", TOC)).toBe("Chapter 1 (continued)");
  });
  it("returns null instead of inventing titles", () => {
    expect(resolveChapterTitle(7, "unknown.xhtml", TOC)).toBeNull();
    expect(resolveChapterTitle(1, "ch01.xhtml", null)).toBeNull();
    expect(resolveChapterTitle(1, "ch01.xhtml", [])).toBeNull();
  });
});

describe("applyChapterSeparatorToDoc", () => {
  it("creates the separator exactly once (single style node, attributes set)", () => {
    const doc = new FakeDoc();
    const first = applyChapterSeparatorToDoc(doc, {
      sectionIndex: 3,
      toc: TOC,
      sectionHref: "ch9.xhtml",
    });
    expect(first).toBe("applied");
    expect(doc.body.getAttribute(CHAPTER_DIVIDER_ATTR)).toBe("true");
    // No TOC match -> plain rule, no title attribute left behind.
    expect(doc.body.getAttribute(CHAPTER_TITLE_ATTR)).toBeNull();
    expect(doc.headChildren.filter((n) => n.id === CHAPTER_SEPARATOR_STYLE_ID)).toHaveLength(1);
  });

  it("rerender is a no-op (no duplicates, no extra elements)", () => {
    const doc = new FakeDoc();
    const ctx = { sectionIndex: 1, toc: TOC, sectionHref: "ch01.xhtml" };
    expect(applyChapterSeparatorToDoc(doc, ctx)).toBe("applied");
    expect(doc.body.getAttribute(CHAPTER_TITLE_ATTR)).toBe("Chapter 1: Beginnings");
    const createdAfterFirst = doc.createdElements;
    expect(applyChapterSeparatorToDoc(doc, ctx)).toBe("skipped");
    expect(applyChapterSeparatorToDoc(doc, ctx)).toBe("skipped");
    expect(doc.createdElements).toBe(createdAfterFirst);
    expect(doc.headChildren.filter((n) => n.id === CHAPTER_SEPARATOR_STYLE_ID)).toHaveLength(1);
  });

  it("creates zero content elements (CFI/text-index safe)", () => {
    const doc = new FakeDoc();
    // Spy: track every created element tag.
    const tags: string[] = [];
    const origCreate = doc.createElement.bind(doc);
    doc.createElement = (tag: string) => {
      tags.push(tag);
      return origCreate(tag);
    };
    applyChapterSeparatorToDoc(doc, { sectionIndex: 2, toc: TOC, sectionHref: "ch01b.xhtml" });
    // Only the guarded <style> in <head> may be created — nothing in content flow.
    expect(tags).toEqual(["style"]);
  });

  it("updates the title when chapter identity changes, clears stale titles", () => {
    const doc = new FakeDoc();
    applyChapterSeparatorToDoc(doc, { sectionIndex: 1, toc: TOC, sectionHref: "ch01.xhtml" });
    expect(doc.body.getAttribute(CHAPTER_TITLE_ATTR)).toBe("Chapter 1: Beginnings");
    const again = applyChapterSeparatorToDoc(doc, {
      sectionIndex: 5,
      toc: TOC,
      sectionHref: "appendix.xhtml",
    });
    expect(again).toBe("applied");
    expect(doc.body.getAttribute(CHAPTER_DIVIDER_ATTR)).toBe("true");
    expect(doc.body.getAttribute(CHAPTER_TITLE_ATTR)).toBeNull();
  });

  it("removes presentation when the divider should not show", () => {
    const doc = new FakeDoc();
    applyChapterSeparatorToDoc(doc, { sectionIndex: 2, toc: TOC, sectionHref: "ch01b.xhtml" });
    expect(applyChapterSeparatorToDoc(doc, { sectionIndex: 0 })).toBe("removed");
    expect(applyChapterSeparatorToDoc(doc, { sectionIndex: 0 })).toBe("skipped");
    expect(doc.body.getAttribute(CHAPTER_DIVIDER_ATTR)).toBeNull();
  });

  it("skips documents without a body", () => {
    const noBody = new FakeDoc();
    (noBody as { body: FakeBody | null }).body = null;
    expect(applyChapterSeparatorToDoc(noBody, { sectionIndex: 2 })).toBe("skipped");
  });
});

describe("removeChapterSeparatorFromDoc", () => {
  it("is safe to call repeatedly and on empty docs", () => {
    const doc = new FakeDoc();
    expect(removeChapterSeparatorFromDoc(doc)).toBe(false);
    applyChapterSeparatorToDoc(doc, { sectionIndex: 2, toc: TOC, sectionHref: "ch01b.xhtml" });
    expect(removeChapterSeparatorFromDoc(doc)).toBe(true);
    expect(removeChapterSeparatorFromDoc(doc)).toBe(false);
    expect(removeChapterSeparatorFromDoc(null)).toBe(false);
  });
});

describe("separatorIdentity", () => {
  it("is stable and prefers href identity over bare index", () => {
    const a = separatorIdentity({ bookId: "b1", chapterHref: "Text/ch2.xhtml", sectionIndex: 4 });
    const b = separatorIdentity({ bookId: "b1", chapterHref: "Text/ch2.xhtml", sectionIndex: 9 });
    expect(a).toBe(b);
    expect(separatorIdentity({ bookId: "b1", sectionIndex: 4 })).toContain("section:4");
    expect(separatorIdentity({ bookId: "b1", sectionIndex: 4 })).not.toBe(
      separatorIdentity({ bookId: "b2", sectionIndex: 4 }),
    );
  });
});

describe("extraction safety", () => {
  it("uses attribute namespaces that cannot collide with translation/search hooks", () => {
    // Translation injection + visibility use these hooks; the separator must
    // never match or overwrite them.
    const reserved = [
      "data-translate-id",
      "data-para-id",
      "data-hidden",
      "data-solo",
      "data-original-hidden",
    ];
    expect(reserved).not.toContain(CHAPTER_DIVIDER_ATTR);
    expect(reserved).not.toContain(CHAPTER_TITLE_ATTR);
    // Separator values are never paragraph text: title resolution only reads
    // TOC labels, never body content.
    expect(resolveChapterTitle(1, "ch01.xhtml", [{ index: 1, label: "  " }])).toBeNull();
  });

  it("never claims content nodes that extraction would translate or index", () => {
    const doc = new FakeDoc();
    applyChapterSeparatorToDoc(doc, { sectionIndex: 4, toc: TOC, sectionHref: "ch9.xhtml" });
    // The only node the engine may create is the guarded head <style>.
    expect(doc.headChildren).toHaveLength(1);
    expect(doc.headChildren[0].id).toBe(CHAPTER_SEPARATOR_STYLE_ID);
  });
});

describe("buildChapterSeparatorCss", () => {
  it("targets only separator attributes and ships a dark-mode variant", () => {
    const css = buildChapterSeparatorCss();
    expect(css).toContain(CHAPTER_DIVIDER_ATTR);
    expect(css).toContain(CHAPTER_TITLE_ATTR);
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    // Presentation-only: no selectors that could match content paragraphs.
    expect(css).not.toMatch(/(^|\s)\.readany-translation/);
  });
});
