/**
 * Lightweight EPUB package access for the Book Overview + background queue.
 *
 * Goals:
 * - List chapters (spine order + TOC titles + entry sizes) WITHOUT parsing
 *   chapter content — fast enough to run on overview open.
 * - Read one section's XHTML at a time during full-book translation
 *   (chapter → extract → translate → save → release), so a 179-chapter book
 *   never holds all chapter DOMs or texts in memory at once.
 * - Paragraph extraction byte-matches the reader WebView path (same block
 *   tags, same `para_<index>` ids, same shared normalization), so queue
 *   translations restore in the reader via the existing paragraph cache.
 */

import { BlobReader, TextWriter, ZipReader, configure } from "@zip.js/zip.js";
import type { ChapterParagraph } from "../translation/chapter-translator";
import { normalizeParagraphText } from "../translation/translation-text";
import {
  type EpubInspectTocItem,
  elementsByLocalName,
  findPackageResourcePath,
  getPackageDir,
  parseNavDocument,
  parseNcxDocument,
  parseXml,
  resolvePackagePath,
} from "./inspect";
import { toArrayBuffer } from "./zip";

configure({ useWebWorkers: false });

export interface PackageChapterRef {
  /** Zero-based spine position — matches reader sectionIndex + cache keys. */
  sectionIndex: number;
  /** Package-relative href (e.g. `OEBPS/Text/ch01.xhtml`). */
  href: string;
  /** TOC title, or `Section N` fallback (never invented chapter names). */
  title: string;
  /** Uncompressed entry size in bytes, when the zip directory provides it. */
  sizeBytes?: number;
}

export interface EpubPackageHandle {
  chapters: PackageChapterRef[];
  readSectionXhtml: (href: string) => Promise<string | null>;
  close: () => Promise<void>;
}

type ZipEntrySized = {
  filename: string;
  directory?: boolean;
  uncompressedSize?: number;
  getData?: (writer: TextWriter) => Promise<string>;
};

/**
 * Block tags extracted as translation paragraphs. MUST stay identical to the
 * reader WebView `blockSelector` (`doGetChapterParagraphs`).
 */
export const CHAPTER_PARAGRAPH_BLOCK_TAGS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "blockquote",
  "dd",
  "dt",
  "figcaption",
  "pre",
  "td",
  "th",
]);

function childElementsOf(element: Element): Element[] {
  return Array.from(element.childNodes).filter((node): node is Element => node.nodeType === 1);
}

/**
 * Extract translation paragraphs from one section document, in document
 * order. Id scheme (`para_<rawIndex>`) and keep-filter mirror the WebView
 * extractor exactly; text runs through the shared normalization.
 */
export function extractParagraphsFromXhtml(xhtml: string): ChapterParagraph[] {
  let doc: Document;
  try {
    doc = parseXml(xhtml) as unknown as Document;
  } catch {
    return [];
  }
  const root = doc.documentElement;
  if (!root) return [];
  // Collect block elements in document order (pre-order walk == querySelectorAll order).
  const blocks: Element[] = [];
  const stack: Element[] = [root];
  while (stack.length > 0) {
    const el = stack.pop() as Element;
    const kids = childElementsOf(el);
    for (let i = kids.length - 1; i >= 0; i--) {
      stack.push(kids[i] as Element);
    }
    const tag = (el.localName || el.tagName || "").toLowerCase();
    if (CHAPTER_PARAGRAPH_BLOCK_TAGS.has(tag)) blocks.push(el);
  }
  const paragraphs: ChapterParagraph[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const el = blocks[i] as Element;
    const tag = (el.localName || el.tagName || "").toLowerCase();
    const text = normalizeParagraphText(el.textContent ?? "");
    if (text.length < 2) continue;
    paragraphs.push({ id: `para_${i}`, text, tagName: tag });
  }
  return paragraphs;
}

function stripFragment(href: string): string {
  return href.split("#")[0] ?? href;
}

function buildTitleMap(toc: EpubInspectTocItem[], packageDir: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const item of toc) {
    const label = (item.label || "").replace(/\s+/g, " ").trim();
    if (!label || !item.href) continue;
    for (const candidate of [
      item.href,
      stripFragment(item.href),
      resolvePackagePath(packageDir, item.href),
      stripFragment(resolvePackagePath(packageDir, item.href)),
    ]) {
      if (candidate && !map.has(candidate)) map.set(candidate, label);
    }
  }
  return map;
}

export async function openEpubPackage(bytes: Uint8Array): Promise<EpubPackageHandle> {
  const buffer = toArrayBuffer(bytes);
  const reader = new ZipReader(new BlobReader(new Blob([buffer])));
  let closed = false;
  try {
    const entries = (await reader.getEntries()) as unknown as ZipEntrySized[];
    const byName = new Map(entries.map((entry) => [entry.filename, entry]));
    const sizeByName = new Map(entries.map((entry) => [entry.filename, entry.uncompressedSize]));
    const readTextEntry = async (path: string): Promise<string | null> => {
      let entry = byName.get(path);
      if (!entry) {
        const lower = path.toLowerCase();
        entry = entries.find((candidate) => candidate.filename.toLowerCase() === lower);
      }
      if (!entry || entry.directory || !entry.getData) return null;
      return entry.getData(new TextWriter());
    };

    const containerXml = await readTextEntry("META-INF/container.xml");
    if (!containerXml) throw new Error("EPUB container.xml was not found.");
    const containerDoc = parseXml(containerXml);
    const rootfile = elementsByLocalName(containerDoc, "rootfile")[0];
    const packagePath = rootfile?.getAttribute("full-path")?.trim();
    if (!packagePath) throw new Error("EPUB container.xml does not declare a package document.");
    const packageDir = getPackageDir(packagePath);
    const opfXml = await readTextEntry(packagePath);
    if (!opfXml) throw new Error(`EPUB package document was not found: ${packagePath}.`);
    const opfDoc = parseXml(opfXml);

    const manifestItems = elementsByLocalName(opfDoc, "item").map((item) => ({
      id: item.getAttribute("id") ?? "",
      href: item.getAttribute("href") ?? "",
      mediaType: item.getAttribute("media-type") ?? "",
      properties: item.getAttribute("properties") || undefined,
    }));
    const manifestById = new Map(manifestItems.map((item) => [item.id, item]));
    const entryPaths = entries.filter((entry) => !entry.directory).map((entry) => entry.filename);

    // TOC (nav first, then NCX) for chapter titles.
    let toc: EpubInspectTocItem[] = [];
    const navItem = manifestItems.find((item) => item.properties?.split(/\s+/).includes("nav"));
    if (navItem?.href) {
      const navPath = findPackageResourcePath(entryPaths, packageDir, navItem.href);
      const navXml = navPath ? await readTextEntry(navPath) : null;
      if (navXml) toc = parseNavDocument(navXml);
    }
    if (toc.length === 0) {
      const spineEl = elementsByLocalName(opfDoc, "spine")[0];
      const tocId = spineEl?.getAttribute("toc") || undefined;
      const ncxItem = tocId
        ? manifestItems.find((item) => item.id === tocId)
        : manifestItems.find((item) => item.mediaType === "application/x-dtbncx+xml");
      if (ncxItem?.href) {
        const ncxPath = findPackageResourcePath(entryPaths, packageDir, ncxItem.href);
        const ncxXml = ncxPath ? await readTextEntry(ncxPath) : null;
        if (ncxXml) toc = parseNcxDocument(ncxXml);
      }
    }
    const titleMap = buildTitleMap(toc, packageDir);

    // Spine in document order — every item (including linear="no" cover pages)
    // so indices match the reader's sectionIndex and translation cache keys.
    const spineElement = elementsByLocalName(opfDoc, "spine")[0];
    const itemrefs = elementsByLocalName(spineElement ?? opfDoc, "itemref");
    const chapters: PackageChapterRef[] = [];
    let sectionIndex = 0;
    for (const itemref of itemrefs) {
      const idref = itemref.getAttribute("idref") ?? "";
      const manifestItem = manifestById.get(idref);
      if (!manifestItem?.href) continue;
      const resolved =
        findPackageResourcePath(entryPaths, packageDir, manifestItem.href) ??
        resolvePackagePath(packageDir, stripFragment(manifestItem.href));
      const title =
        titleMap.get(resolved) ??
        titleMap.get(stripFragment(resolved)) ??
        titleMap.get(manifestItem.href) ??
        `Section ${sectionIndex + 1}`;
      const size = sizeByName.get(resolved);
      chapters.push({
        sectionIndex,
        href: resolved,
        title,
        ...(typeof size === "number" ? { sizeBytes: size } : {}),
      });
      sectionIndex += 1;
    }

    return {
      chapters,
      readSectionXhtml: async (href: string) => readTextEntry(href),
      close: async () => {
        if (!closed) {
          closed = true;
          await reader.close();
        }
      },
    };
  } catch (err) {
    await reader.close().catch(() => {});
    throw err;
  }
}
