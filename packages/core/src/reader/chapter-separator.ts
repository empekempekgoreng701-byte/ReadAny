/**
 * Chapter separator (continuous-scroll reader).
 *
 * Design constraints (see project prompt §§4-11):
 * - Continuous scroll is preserved; the separator is presentation-only.
 * - The separator must NEVER shift EPUB locators: it adds zero element/text
 *   nodes to the content flow. Only a `<style>` node in `<head>` plus two
 *   inert attributes on `<body>` are used; the visible rule + chapter title
 *   are rendered via CSS (`border-top` + `body::before` with
 *   `content: attr(...)`). Pseudo-elements are invisible to DOM traversal,
 *   so CFI child indices, `textContent`-based extraction (search), paragraph
 *   counts, source hashes, and image indices are all unaffected.
 * - Idempotent: re-applying to the same document is a no-op (attribute
 *   comparison + style-node id guard), so preload/unload cycles and repeated
 *   `load` events can never create duplicates.
 * - Stable identity: bookId + chapterHref/chapterId + sectionIndex (never a
 *   random id, never bare numeric index when href identity exists).
 */

export const CHAPTER_SEPARATOR_STYLE_ID = "readany-chapter-separator-style";
export const CHAPTER_DIVIDER_ATTR = "data-chapter-divider";
export const CHAPTER_TITLE_ATTR = "data-chapter-title";

/** Max title length rendered into the separator (TOC labels can be noisy). */
export const CHAPTER_SEPARATOR_TITLE_MAX_LENGTH = 140;

export interface ChapterSeparatorTocEntry {
  index?: number | null;
  href?: string | null;
  label?: string | null;
  subitems?: ChapterSeparatorTocEntry[] | null;
}

export interface ChapterSeparatorContext {
  /** Zero-based spine/section index. */
  sectionIndex: number;
  /** Raw section href (e.g. `Text/ch02.xhtml`), when known. */
  sectionHref?: string | null;
  /** Book TOC used for chapter title resolution. */
  toc?: ChapterSeparatorTocEntry[] | null;
  /** Fixed-layout (comics) documents must not get separators. */
  isFixedLayout?: boolean;
  /** Hard kill-switch (e.g. PDF books). */
  disabled?: boolean;
}

export interface ChapterSeparatorIdentity {
  bookId: string;
  chapterHref?: string | null;
  chapterId?: string | null;
  sectionIndex: number;
}

/** Minimal document surface the separator needs (mirrors real DOM). */
export interface SeparatorDocumentLike {
  head?: { appendChild: (node: unknown) => void } | null;
  body?: {
    setAttribute: (name: string, value: string) => void;
    getAttribute: (name: string) => string | null;
    removeAttribute: (name: string) => void;
  } | null;
  getElementById: (id: string) => { textContent?: string | null } | null;
  createElement: (tag: string) => { id?: string; textContent?: string | null };
}

export type SeparatorApplyResult = "applied" | "skipped" | "removed";

/** First section of the book needs no divider; fixed layouts are excluded. */
export function shouldShowDivider(ctx: ChapterSeparatorContext | null | undefined): boolean {
  if (!ctx || ctx.disabled || ctx.isFixedLayout) return false;
  const index = Math.floor(Number(ctx.sectionIndex));
  return Number.isInteger(index) && index > 0;
}

function normalizeTitleLabel(label: string | null | undefined): string | null {
  if (!label) return null;
  const collapsed = String(label).replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  return collapsed.length > CHAPTER_SEPARATOR_TITLE_MAX_LENGTH
    ? `${collapsed.slice(0, CHAPTER_SEPARATOR_TITLE_MAX_LENGTH - 1).trimEnd()}…`
    : collapsed;
}

function stripFragment(href: string | null | undefined): string | null {
  if (!href) return null;
  const base = String(href).split("#")[0];
  return base || null;
}

/**
 * Resolve a human chapter title for a section: exact spine-index match first,
 * then full href, then href without fragment. Walks nested TOC subitems.
 * Returns null when nothing resolves (caller renders a plain rule instead of
 * inventing a title).
 */
export function resolveChapterTitle(
  sectionIndex: number,
  sectionHref: string | null | undefined,
  toc: ChapterSeparatorTocEntry[] | null | undefined,
): string | null {
  if (!toc || !toc.length) return null;
  const index = Math.floor(Number(sectionIndex));
  const href = sectionHref != null ? String(sectionHref) : null;
  const base = stripFragment(href);

  const visit = (
    items: ChapterSeparatorTocEntry[],
  ): { byIndex: string | null; byHref: string | null; byBase: string | null } => {
    let byIndex: string | null = null;
    let byHref: string | null = null;
    let byBase: string | null = null;
    const stack: ChapterSeparatorTocEntry[][] = [items];
    while (stack.length > 0) {
      const current = stack.pop() as ChapterSeparatorTocEntry[];
      for (const item of current) {
        if (!item) continue;
        const label = normalizeTitleLabel(item.label);
        if (label) {
          if (byIndex == null && item.index != null && Number(item.index) === index) {
            byIndex = label;
          }
          const itemHref = item.href != null ? String(item.href) : null;
          if (byHref == null && href != null && itemHref === href) {
            byHref = label;
          }
          const itemBase = stripFragment(itemHref);
          if (byBase == null && base != null && itemBase === base) {
            byBase = label;
          }
        }
        if (item.subitems && item.subitems.length > 0) stack.push(item.subitems);
      }
    }
    return { byIndex, byHref, byBase };
  };

  const found = visit(toc);
  return found.byIndex ?? found.byHref ?? found.byBase;
}

/** Presentation CSS. Colors follow the neutral translation-note aesthetic. */
export function buildChapterSeparatorCss(): string {
  return [
    `body[${CHAPTER_DIVIDER_ATTR}="true"] {`,
    "  border-top: 2px solid #d1d5db;",
    "  margin-top: 28px;",
    "  padding-top: 14px;",
    "}",
    `body[${CHAPTER_DIVIDER_ATTR}="true"][${CHAPTER_TITLE_ATTR}]:not([${CHAPTER_TITLE_ATTR}=""])::before {`,
    `  content: attr(${CHAPTER_TITLE_ATTR});`,
    "  display: block;",
    "  font-size: 1.05em;",
    "  font-weight: 700;",
    "  line-height: 1.4;",
    "  color: #4b5563;",
    "  letter-spacing: 0.01em;",
    "  margin-bottom: 12px;",
    "  overflow-wrap: anywhere;",
    "}",
    "@media (prefers-color-scheme: dark) {",
    `  body[${CHAPTER_DIVIDER_ATTR}="true"] { border-top-color: #4b5563; }`,
    `  body[${CHAPTER_DIVIDER_ATTR}="true"][${CHAPTER_TITLE_ATTR}]:not([${CHAPTER_TITLE_ATTR}=""])::before { color: #d1d5db; }`,
    "}",
  ].join("\n");
}

function ensureSeparatorStyle(doc: SeparatorDocumentLike, cssText: string): void {
  if (!doc || typeof doc.getElementById !== "function") return;
  const existing = doc.getElementById(CHAPTER_SEPARATOR_STYLE_ID);
  if (existing) return;
  if (!doc.head || typeof doc.createElement !== "function") return;
  const style = doc.createElement("style");
  style.id = CHAPTER_SEPARATOR_STYLE_ID;
  style.textContent = cssText;
  doc.head.appendChild(style);
}

/**
 * Apply (or refresh) the separator on one section document.
 * Creates at most the single guarded `<style>` node — never content nodes.
 */
export function applyChapterSeparatorToDoc(
  doc: SeparatorDocumentLike | null | undefined,
  ctx: ChapterSeparatorContext,
  cssText: string = buildChapterSeparatorCss(),
): SeparatorApplyResult {
  if (!doc || !doc.body) return "skipped";
  if (!shouldShowDivider(ctx)) {
    const removed = removeChapterSeparatorFromDoc(doc);
    return removed ? "removed" : "skipped";
  }
  ensureSeparatorStyle(doc, cssText);
  const title = resolveChapterTitle(ctx.sectionIndex, ctx.sectionHref ?? null, ctx.toc ?? null);
  const body = doc.body;
  const wantDivider = "true";
  const hasDivider = body.getAttribute(CHAPTER_DIVIDER_ATTR);
  const hasTitle = body.getAttribute(CHAPTER_TITLE_ATTR);
  if (hasDivider === wantDivider && (hasTitle ?? "") === (title ?? "")) {
    return "skipped";
  }
  body.setAttribute(CHAPTER_DIVIDER_ATTR, wantDivider);
  if (title) {
    body.setAttribute(CHAPTER_TITLE_ATTR, title);
  } else {
    body.removeAttribute(CHAPTER_TITLE_ATTR);
  }
  return "applied";
}

/** Remove separator presentation from a document. Safe to call repeatedly. */
export function removeChapterSeparatorFromDoc(
  doc: SeparatorDocumentLike | null | undefined,
): boolean {
  if (!doc || !doc.body) return false;
  let removed = false;
  try {
    if (doc.body.getAttribute(CHAPTER_DIVIDER_ATTR) != null) {
      doc.body.removeAttribute(CHAPTER_DIVIDER_ATTR);
      removed = true;
    }
    if (doc.body.getAttribute(CHAPTER_TITLE_ATTR) != null) {
      doc.body.removeAttribute(CHAPTER_TITLE_ATTR);
      removed = true;
    }
  } catch {
    return removed;
  }
  return removed;
}

/**
 * Stable separator identity: prefers href-based chapter identity, falls back
 * to the positional section index only when no href identity exists.
 */
export function separatorIdentity(id: ChapterSeparatorIdentity): string {
  const book = String(id.bookId ?? "");
  const chapter =
    (id.chapterHref != null && String(id.chapterHref)) ||
    (id.chapterId != null ? `id:${String(id.chapterId)}` : null) ||
    `section:${Math.floor(Number(id.sectionIndex))}`;
  return `chapter-separator|${book}|${chapter}`;
}

export interface ReadAnyChapterSeparatorApi {
  applyToDoc: (
    doc: SeparatorDocumentLike | null | undefined,
    ctx: ChapterSeparatorContext,
  ) => SeparatorApplyResult;
  removeFromDoc: (doc: SeparatorDocumentLike | null | undefined) => boolean;
  constants: {
    styleId: string;
    dividerAttr: string;
    titleAttr: string;
  };
}

/** Installs `globalThis.ReadAnyChapterSeparator` for the reader WebView. */
export function installReadAnyChapterSeparator(host: unknown): void {
  const scope = host as Record<string, unknown>;
  if (!scope || typeof scope !== "object") return;
  const api: ReadAnyChapterSeparatorApi = {
    applyToDoc: (doc, ctx) => applyChapterSeparatorToDoc(doc, ctx),
    removeFromDoc: (doc) => removeChapterSeparatorFromDoc(doc),
    constants: {
      styleId: CHAPTER_SEPARATOR_STYLE_ID,
      dividerAttr: CHAPTER_DIVIDER_ATTR,
      titleAttr: CHAPTER_TITLE_ATTR,
    },
  };
  scope.ReadAnyChapterSeparator = api;
}
