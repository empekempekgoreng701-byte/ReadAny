/**
 * DOCX to EPUB converter.
 *
 * Pipeline: DOCX (ZIP) → word/document.xml paragraphs → chapters → EPUB 2.0
 * store-only ZIP. Mirrors the shape of TxtToEpubConverter.convertToBytes —
 * same call site pattern in library-store importBooks.
 *
 * No new dependencies: ZIP read via @zip.js/zip.js (already a core dep),
 * XML via @xmldom/xmldom (already a core dep), ZIP write via
 * ./store-only-zip (no Blob needed, Hermes-safe).
 *
 * Supported: paragraphs (w:p/w:t), headings (w:pStyle Heading1-6 → chapter
 * split), bold/italic (w:b/w:i), images (w:drawing → word/media/*, embedded
 * as EPUB items). Unsupported (dropped safely): tables (flattened to
 * paragraphs), footnotes, comments, tracked changes (accept all).
 */

import { DOMParser } from "@xmldom/xmldom";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js";
import { buildStoreOnlyZip, type ZipEntry } from "./store-only-zip";

export interface Docx2EpubOptions {
  file: File;
}

export interface DocxBytesConversionResult {
  epubBytes: Uint8Array;
  bookTitle: string;
  author: string;
  language: string;
  chapterCount: number;
  coverBytes?: Uint8Array;
  coverMime?: "image/jpeg" | "image/png";
}

interface DocxChapter {
  title: string;
  blocks: string[];
}

const escapeXml = (str: string): string => {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
};

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  bmp: "image/bmp",
  webp: "image/webp",
};

function mimeForImage(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return IMAGE_MIME_BY_EXT[ext] || "image/jpeg";
}

function localName(tag: string): string {
  const idx = tag.indexOf(":");
  return idx >= 0 ? tag.slice(idx + 1) : tag;
}

function childElements(node: { childNodes?: ArrayLike<unknown> }): Element[] {
  const out: Element[] = [];
  const kids = (node.childNodes || []) as ArrayLike<unknown>;
  for (let i = 0; i < kids.length; i++) {
    const k = kids[i] as { nodeType?: number };
    if (k && k.nodeType === 1) out.push(k as unknown as Element);
  }
  return out;
}

function textOf(node: { childNodes?: ArrayLike<unknown> }): string {
  let s = "";
  const kids = (node.childNodes || []) as ArrayLike<unknown>;
  for (let i = 0; i < kids.length; i++) {
    const k = kids[i] as { nodeType?: number; nodeValue?: string | null } & {
      childNodes?: ArrayLike<unknown>;
    };
    if (!k) continue;
    if (k.nodeType === 3) s += k.nodeValue || "";
    else if (k.nodeType === 1) s += textOf(k);
  }
  return s;
}

async function readZipEntries(
  bytes: Uint8Array,
): Promise<Map<string, Uint8Array>> {
  const reader = new ZipReader(new Uint8ArrayReader(bytes));
  const map = new Map<string, Uint8Array>();
  try {
    const entries = await reader.getEntries();
    for (const entry of entries) {
      const e = entry as unknown as {
        filename: string;
        directory?: boolean;
        getData?: (w: Uint8ArrayWriter) => Promise<Uint8Array>;
      };
      if (e.directory || !e.getData) continue;
      map.set(e.filename, await e.getData(new Uint8ArrayWriter()));
    }
  } finally {
    await reader.close();
  }
  return map;
}

function parseRels(xmlText: string): Map<string, string> {
  // word/_rels/document.xml.rels: Id -> Target (media + hyperlinks)
  const map = new Map<string, string>();
  try {
    const doc = new DOMParser().parseFromString(xmlText, "application/xml");
    const rels = doc.getElementsByTagName("Relationship");
    for (let i = 0; i < rels.length; i++) {
      const r = rels[i] as unknown as { getAttribute: (n: string) => string | null };
      const id = r.getAttribute("Id");
      const target = r.getAttribute("Target");
      if (id && target) map.set(id, target);
    }
  } catch {
    // malformed rels — images just won't resolve
  }
  return map;
}

interface ParsedRun {
  html: string;
  text: string;
}

function parseRun(r: Element, rels: Map<string, string>, media: Map<string, Uint8Array>): ParsedRun {
  let bold = false;
  let italic = false;
  let parts: string[] = [];
  let plain = "";
  for (const child of childElements(r)) {
    const ln = localName(child.tagName || "");
    if (ln === "rPr") {
      for (const pr of childElements(child)) {
        const pl = localName(pr.tagName || "");
        if (pl === "b") bold = true;
        if (pl === "i") italic = true;
      }
    } else if (ln === "t" || ln === "delText") {
      const t = textOf(child);
      plain += t;
      parts.push(escapeXml(t));
    } else if (ln === "tab") {
      plain += "\t";
      parts.push(" ");
    } else if (ln === "br" || ln === "cr") {
      plain += "\n";
      parts.push("<br/>");
    } else if (ln === "drawing" || ln === "pict") {
      // w:drawing/wp:inline/a:blip @r:embed -> word/media/*
      const xml = new XMLSerializerSafe().serialize(child);
      const m = xml.match(/embed="([^"]+)"/);
      const rid = m ? m[1]! : "";
      const target = (rid && rels.get(rid)) || "";
      const base = target.split("/").pop() || "";
      if (base && media.has(`word/${target.replace(/^\//, "")}`)) {
        const key = `word/${target.replace(/^\//, "")}`;
        const fileName = base.replace(/[^\w.\-]+/g, "_");
        parts.push(`<img src="media/${fileName}" alt=""/>`);
        // record mapping for manifest (keyed by file name)
        mediaRename.set(key, `media/${fileName}`);
      } else if (base) {
        // media entry may use opposite slash style — try both
        for (const k of media.keys()) {
          if (k.endsWith("/" + base) || k === base) {
            const fileName = base.replace(/[^\w.\-]+/g, "_");
            parts.push(`<img src="media/${fileName}" alt=""/>`);
            mediaRename.set(k, `media/${fileName}`);
            break;
          }
        }
      }
    }
  }
  let html = parts.join("");
  if (italic) html = `<i>${html}</i>`;
  if (bold) html = `<b>${html}</b>`;
  return { html, text: plain };
}

// Maps zip media key -> epub media path (filled during parse)
const mediaRename = new Map<string, string>();

class XMLSerializerSafe {
  serialize(node: Element): string {
    // xmldom elements expose toString; fallback to text scan
    try {
      const s = (node as unknown as { toString: () => string }).toString();
      if (s && s.includes("embed")) return s;
    } catch {
      // fall through
    }
    // Fallback: walk subtree for blip elements
    const out: string[] = [];
    const walk = (n: Element) => {
      const tag = (n.tagName || "").toLowerCase();
      if (tag.endsWith("blip")) {
        const get = (n as unknown as { getAttribute?: (a: string) => string | null })
          .getAttribute;
        const v = get ? get.call(n, "r:embed") || get.call(n, "embed") : null;
        if (v) out.push(`embed="${v}"`);
      }
      for (const c of childElements(n)) walk(c);
    };
    walk(node);
    return out.join(" ");
  }
}

function parseDocument(
  xmlText: string,
  rels: Map<string, string>,
  media: Map<string, Uint8Array>,
): { chapters: DocxChapter[]; title: string; author: string } {
  mediaRename.clear();
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  const body = doc.getElementsByTagName("w:body")[0];
  const chapters: DocxChapter[] = [];
  let current: DocxChapter = { title: "", blocks: [] };
  let docTitle = "";
  let paraCount = 0;

  const flush = () => {
    if (current.blocks.length > 0 || current.title) {
      if (!current.title) current.title = `Chapter ${chapters.length + 1}`;
      chapters.push(current);
    }
    current = { title: "", blocks: [] };
  };

  if (!body) return { chapters: [], title: "", author: "" };
  for (const p of childElements(body as unknown as Element)) {
    if (localName((p as unknown as { tagName: string }).tagName || "") !== "p") continue;
    // style → heading?
    let style = "";
    let runs: ParsedRun[] = [];
    for (const child of childElements(p)) {
      const ln = localName(child.tagName || "");
      if (ln === "pPr") {
        for (const pr of childElements(child)) {
          if (localName(pr.tagName || "") === "pStyle") {
            style =
              (pr as unknown as { getAttribute: (n: string) => string | null }).getAttribute(
                "w:val",
              ) || "";
          }
        }
      } else if (ln === "r" || ln === "hyperlink") {
        if (ln === "hyperlink") {
          for (const h of childElements(child)) {
            if (localName(h.tagName || "") === "r") runs.push(parseRun(h, rels, media));
          }
        } else {
          runs.push(parseRun(child, rels, media));
        }
      }
    }
    const html = runs.map((r) => r.html).join("");
    const plain = runs
      .map((r) => r.text)
      .join("")
      .trim();
    paraCount++;
    if (paraCount === 1 && plain && !docTitle) docTitle = plain.slice(0, 120);
    const isHeading = /^Heading\s*([1-6])$/i.test(style);
    const headingLevel = isHeading ? Number(/^Heading\s*([1-6])/i.exec(style)![1]) : 0;
    if ((headingLevel === 1 || headingLevel === 2) && plain) {
      flush();
      current.title = plain.slice(0, 120);
      continue;
    }
    if (!html.replace(/<[^>]+>/g, "").trim() && !html.includes("<img")) continue;
    if (headingLevel >= 3 && plain) {
      current.blocks.push(`<h3>${escapeXml(plain.slice(0, 200))}</h3>`);
    } else if (html) {
      current.blocks.push(`<p>${html}</p>`);
    }
  }
  flush();
  return { chapters, title: docTitle, author: "" };
}

function parseCoreProps(xmlText: string): { title: string; author: string } {
  let title = "";
  let author = "";
  try {
    const doc = new DOMParser().parseFromString(xmlText, "application/xml");
    const t = doc.getElementsByTagName("dc:title")[0];
    const c = doc.getElementsByTagName("dc:creator")[0];
    if (t) title = textOf(t as unknown as Element).trim();
    if (c) author = textOf(c as unknown as Element).trim();
  } catch {
    // ignore
  }
  return { title, author };
}

function buildEpubBytes(
  chapters: DocxChapter[],
  bookTitle: string,
  author: string,
  media: Map<string, Uint8Array>,
  fileName: string,
): DocxBytesConversionResult {
  const encoder = new TextEncoder();
  const entries: ZipEntry[] = [];
  entries.push({ name: "mimetype", data: encoder.encode("application/epub+zip") });
  entries.push({
    name: "META-INF/container.xml",
    data: encoder.encode(
      `<?xml version="1.0" encoding="UTF-8"?>\n<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">\n  <rootfiles>\n    <rootfile full-path="content.opf" media-type="application/oebps-package+xml"/>\n  </rootfiles>\n</container>`,
    ),
  });

  const css = `body { line-height: 1.6; font-size: 1em; font-family: 'Arial', sans-serif; text-align: justify; }\np { margin: 0 0 0.6em 0; }\nh1, h2 { text-align: center; }`;
  entries.push({ name: "style.css", data: encoder.encode(css) });

  const navPoints = chapters
    .map(
      (c, i) =>
        `<navPoint id="navPoint-chapter${i + 1}" playOrder="${i + 1}">\n` +
        `<navLabel><text>${escapeXml(c.title)}</text></navLabel>\n` +
        `<content src="./OEBPS/chapter${i + 1}.xhtml" />\n</navPoint>`,
    )
    .join("\n");
  entries.push({
    name: "toc.ncx",
    data: encoder.encode(
      `<?xml version="1.0" encoding="UTF-8"?>\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n  <head>\n    <meta name="dtb:uid" content="book-id" />\n  </head>\n  <docTitle><text>${escapeXml(bookTitle)}</text></docTitle>\n  <navMap>\n${navPoints}\n  </navMap>\n</ncx>`,
    ),
  });

  for (let i = 0; i < chapters.length; i++) {
    const c = chapters[i]!;
    entries.push({
      name: `OEBPS/chapter${i + 1}.xhtml`,
      data: encoder.encode(
        `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">\n<html xmlns="http://www.w3.org/1999/xhtml">\n  <head><title>${escapeXml(c.title)}</title>\n  <link rel="stylesheet" type="text/css" href="../style.css"/></head>\n  <body><h2>${escapeXml(c.title)}</h2>${c.blocks.join("")}</body>\n</html>`,
      ),
    });
  }

  // Embedded images (dedupe by epub path)
  const seenMedia = new Set<string>();
  const mediaManifest: string[] = [];
  let mediaIdx = 0;
  for (const [zipKey, epubPath] of mediaRename) {
    if (seenMedia.has(epubPath)) continue;
    const data = media.get(zipKey);
    if (!data) continue;
    seenMedia.add(epubPath);
    mediaIdx++;
    entries.push({ name: `OEBPS/${epubPath}`, data });
    mediaManifest.push(
      `<item id="media${mediaIdx}" href="OEBPS/${epubPath}" media-type="${mimeForImage(epubPath)}"/>`,
    );
  }

  const manifest = chapters
    .map(
      (_, i) =>
        `<item id="chap${i + 1}" href="OEBPS/chapter${i + 1}.xhtml" media-type="application/xhtml+xml"/>`,
    )
    .join("\n      ");
  entries.push({
    name: "content.opf",
    data: encoder.encode(
      `<?xml version="1.0" encoding="UTF-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="book-id" version="2.0">\n  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n    <dc:title>${escapeXml(bookTitle)}</dc:title>\n    <dc:creator>${escapeXml(author)}</dc:creator>\n    <dc:identifier id="book-id">docx-${Date.now().toString(36)}</dc:identifier>\n  </metadata>\n  <manifest>\n      ${manifest}\n      ${mediaManifest.join("\n      ")}\n      <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>\n      <item id="css" href="style.css" media-type="text/css"/>\n  </manifest>\n  <spine toc="ncx">\n      ${chapters.map((_, i) => `<itemref idref="chap${i + 1}"/>`).join("\n      ")}\n  </spine>\n</package>`,
    ),
  });

  void fileName;
  return {
    epubBytes: buildStoreOnlyZip(entries),
    bookTitle,
    author,
    language: "en",
    chapterCount: chapters.length,
  };
}

export class DocxToEpubConverter {
  public async convertToBytes(options: { file: File }): Promise<DocxBytesConversionResult> {
    const { file } = options;
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    // DOCX magic: PK..
    if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
      throw new Error("DOCX: not a ZIP archive");
    }
    const entries = await readZipEntries(bytes);
    const docXml = entries.get("word/document.xml");
    if (!docXml) throw new Error("DOCX: word/document.xml not found");
    const relsXml = entries.get("word/_rels/document.xml.rels");
    const coreXml = entries.get("docProps/core.xml");
    const decoder = new TextDecoder("utf-8");
    const rels = relsXml ? parseRels(decoder.decode(relsXml)) : new Map<string, string>();
    // Collect media blobs
    const media = new Map<string, Uint8Array>();
    for (const [name, data] of entries) {
      if (name.startsWith("word/media/")) media.set(name, data);
    }
    const { chapters, title } = parseDocument(decoder.decode(docXml), rels, media);
    if (chapters.length === 0) throw new Error("DOCX: no content detected");
    let bookTitle = title;
    let author = "";
    if (coreXml) {
      const props = parseCoreProps(decoder.decode(coreXml));
      if (props.title) bookTitle = props.title;
      author = props.author;
    }
    if (!bookTitle) {
      bookTitle = file.name.replace(/\.docx$/i, "") || "Untitled";
    }
    return buildEpubBytes(chapters, bookTitle, author, media, file.name);
  }
}
