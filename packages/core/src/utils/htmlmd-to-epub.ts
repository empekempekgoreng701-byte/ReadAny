/**
 * HTML / Markdown to EPUB converter.
 *
 * Pipeline: HTML string (or Markdown → HTML via a small built-in parser) →
 * chapters (split on h1/h2) → EPUB 2.0 store-only ZIP. Mirrors the shape of
 * TxtToEpubConverter.convertToBytes.
 *
 * No new dependencies: the Markdown subset (headings, paragraphs, lists,
 * quotes, code, bold/italic, links, images-as-alt-text) is parsed inline.
 * External images are NOT embedded (offline EPUB) — their alt text is kept.
 */

import { buildStoreOnlyZip, type ZipEntry } from "./store-only-zip";

export type HtmlMdSourceKind = "html" | "markdown";

export interface HtmlMd2EpubOptions {
  file: File;
  kind: HtmlMdSourceKind;
}

export interface HtmlMdBytesConversionResult {
  epubBytes: Uint8Array;
  bookTitle: string;
  author: string;
  language: string;
  chapterCount: number;
}

interface HtmlMdChapter {
  title: string;
  html: string;
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

const escapeHtml = escapeXml;

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

/** Minimal Markdown → HTML (block + inline subset). */
function markdownToHtml(src: string): string {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let inCode = false;
  let codeBuf: string[] = [];
  let listOpen = false;
  let quoteBuf: string[] = [];
  let paraBuf: string[] = [];

  const flushPara = () => {
    if (paraBuf.length > 0) {
      out.push(`<p>${inlineMd(paraBuf.join(" "))}</p>`);
      paraBuf = [];
    }
  };
  const flushQuote = () => {
    if (quoteBuf.length > 0) {
      out.push(`<blockquote>${quoteBuf.map((q) => `<p>${inlineMd(q)}</p>`).join("")}</blockquote>`);
      quoteBuf = [];
    }
  };
  const flushList = () => {
    if (listOpen) {
      out.push("</ul>");
      listOpen = false;
    }
  };

  for (const raw of lines) {
    const line = raw;
    if (/^```/.test(line.trim())) {
      if (inCode) {
        out.push(`<pre>${escapeHtml(codeBuf.join("\n"))}</pre>`);
        codeBuf = [];
        inCode = false;
      } else {
        flushPara();
        flushQuote();
        flushList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      flushQuote();
      flushList();
      const level = Math.min(3, h[1]!.length);
      out.push(`<h${level}>${inlineMd(h[2]!.trim())}</h${level}>`);
      continue;
    }
    const li = /^[*\-+]\s+(.*)$/.exec(line);
    if (li) {
      flushPara();
      flushQuote();
      if (!listOpen) {
        out.push("<ul>");
        listOpen = true;
      }
      out.push(`<li>${inlineMd(li[1]!.trim())}</li>`);
      continue;
    }
    const q = /^>\s?(.*)$/.exec(line);
    if (q) {
      flushPara();
      flushList();
      quoteBuf.push(q[1] ?? "");
      continue;
    }
    if (/^\s*$/.test(line)) {
      flushPara();
      flushQuote();
      flushList();
      continue;
    }
    if (/^(\*\*\*|---|___)\s*$/.test(line.trim())) {
      flushPara();
      flushQuote();
      flushList();
      out.push("<hr/>");
      continue;
    }
    paraBuf.push(line.trim());
  }
  flushPara();
  flushQuote();
  flushList();
  if (inCode) out.push(`<pre>${escapeHtml(codeBuf.join("\n"))}</pre>`);
  return out.join("\n");
}

function inlineMd(s: string): string {
  let out = escapeHtml(s);
  // images → alt text (offline EPUB has no remote fetch)
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, "[$1]");
  // links → text (keep text only)
  out = out.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // inline code
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  // bold + italic
  out = out.replace(/\*\*\*([^*]+)\*\*\*/g, "<b><i>$1</i></b>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  out = out.replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, "$1<i>$2</i>");
  out = out.replace(/(^|[^_\w])_([^_\n]+)_(?![_\w])/g, "$1<i>$2</i>");
  return out;
}

/** Sanitize arbitrary HTML down to an EPUB-safe subset. */
function sanitizeHtml(html: string): string {
  let out = html;
  // Drop scripts/styles and their content
  out = out.replace(/<script[\s\S]*?<\/script\s*>/gi, "");
  out = out.replace(/<style[\s\S]*?<\/style\s*>/gi, "");
  // Drop remote media, keep alt text
  out = out.replace(/<img\b[^>]*alt="([^"]*)"[^>]*>/gi, "[$1]");
  out = out.replace(/<img\b[^>]*>/gi, "");
  out = out.replace(/<(audio|video|iframe|object|embed|canvas|form|input|button|select|textarea)[\s\S]*?<\/\1\s*>/gi, "");
  out = out.replace(/<(audio|video|iframe|object|embed|canvas)[^>]*\/?>/gi, "");
  // Strip event handlers + javascript: hrefs
  out = out.replace(/\son\w+="[^"]*"/gi, "");
  out = out.replace(/\son\w+='[^']*'/gi, "");
  out = out.replace(/href="javascript:[^"]*"/gi, 'href="#"');
  return out;
}

function extractBody(html: string): string {
  const m = /<body[^>]*>([\s\S]*?)<\/body\s*>/i.exec(html);
  return m ? m[1]! : html;
}

function extractTitle(html: string, fallback: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  const t = m ? stripTags(m[1]!) : "";
  if (t) return t.slice(0, 200);
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(html);
  const h = h1 ? stripTags(h1[1]!) : "";
  if (h) return h.slice(0, 200);
  return fallback;
}

function splitChapters(html: string, fallbackTitle: string): HtmlMdChapter[] {
  // Split on h1/h2; each becomes a chapter. If none, single chapter.
  const parts = html.split(/<h([12])[^>]*>([\s\S]*?)<\/h\1\s*>/gi);
  // parts[0] = prelude, then (level, title, body) triples
  const chapters: HtmlMdChapter[] = [];
  const prelude = (parts[0] || "").trim();
  if (prelude.replace(/<[^>]+>/g, "").trim().length > 0) {
    chapters.push({ title: fallbackTitle, html: prelude });
  }
  for (let i = 1; i + 2 < parts.length + 1; i += 3) {
    const title = stripTags(parts[i + 1] || "").slice(0, 200) || fallbackTitle;
    const body = parts[i + 2] || "";
    if (body.replace(/<[^>]+>/g, "").trim().length === 0) continue;
    chapters.push({ title, html: body });
  }
  if (chapters.length === 0) {
    chapters.push({ title: fallbackTitle, html });
  }
  return chapters;
}

function buildEpubBytes(
  chapters: HtmlMdChapter[],
  bookTitle: string,
): HtmlMdBytesConversionResult {
  const encoder = new TextEncoder();
  const entries: ZipEntry[] = [];
  entries.push({ name: "mimetype", data: encoder.encode("application/epub+zip") });
  entries.push({
    name: "META-INF/container.xml",
    data: encoder.encode(
      `<?xml version="1.0" encoding="UTF-8"?>\n<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">\n  <rootfiles>\n    <rootfile full-path="content.opf" media-type="application/oebps-package+xml"/>\n  </rootfiles>\n</container>`,
    ),
  });
  const css = `body { line-height: 1.6; font-size: 1em; font-family: 'Arial', sans-serif; text-align: justify; }\np { margin: 0 0 0.6em 0; }`;
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
      `<?xml version="1.0" encoding="UTF-8"?>\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n  <head><meta name="dtb:uid" content="book-id" /></head>\n  <docTitle><text>${escapeXml(bookTitle)}</text></docTitle>\n  <navMap>\n${navPoints}\n  </navMap>\n</ncx>`,
    ),
  });

  for (let i = 0; i < chapters.length; i++) {
    const c = chapters[i]!;
    entries.push({
      name: `OEBPS/chapter${i + 1}.xhtml`,
      data: encoder.encode(
        `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">\n<html xmlns="http://www.w3.org/1999/xhtml">\n  <head><title>${escapeXml(c.title)}</title>\n  <link rel="stylesheet" type="text/css" href="../style.css"/></head>\n  <body><h2>${escapeXml(c.title)}</h2>${c.html}</body>\n</html>`,
      ),
    });
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
      `<?xml version="1.0" encoding="UTF-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="book-id" version="2.0">\n  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n    <dc:title>${escapeXml(bookTitle)}</dc:title>\n    <dc:identifier id="book-id">htmlmd-${Date.now().toString(36)}</dc:identifier>\n  </metadata>\n  <manifest>\n      ${manifest}\n      <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>\n      <item id="css" href="style.css" media-type="text/css"/>\n  </manifest>\n  <spine toc="ncx">\n      ${chapters.map((_, i) => `<itemref idref="chap${i + 1}"/>`).join("\n      ")}\n  </spine>\n</package>`,
    ),
  });

  return {
    epubBytes: buildStoreOnlyZip(entries),
    bookTitle,
    author: "",
    language: "en",
    chapterCount: chapters.length,
  };
}

export class HtmlMdToEpubConverter {
  public async convertToBytes(options: HtmlMd2EpubOptions): Promise<HtmlMdBytesConversionResult> {
    const { file, kind } = options;
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const text = new TextDecoder("utf-8").decode(bytes);
    if (!text.trim()) throw new Error(`${kind.toUpperCase()}: empty file`);
    const fallbackTitle = file.name.replace(/\.(html?|md|markdown)$/i, "") || "Untitled";

    let bodyHtml: string;
    let bookTitle = fallbackTitle;
    if (kind === "markdown") {
      bodyHtml = markdownToHtml(text);
      // First h1 is the book title when multiple h1 sections exist
      // (common Markdown structure: # Title, then ## sections or more # parts)
      const h1Count = (bodyHtml.match(/<h1>/g) || []).length;
      const firstH1 = /<h1>([\s\S]*?)<\/h1>/.exec(bodyHtml);
      if (h1Count >= 1 && firstH1 && stripTags(firstH1[1]!).length > 0) {
        bookTitle = stripTags(firstH1[1]!).slice(0, 200);
      }
    } else {
      const sanitized = sanitizeHtml(text);
      bookTitle = extractTitle(sanitized, fallbackTitle);
      bodyHtml = extractBody(sanitized);
    }
    const chapters = splitChapters(bodyHtml, bookTitle);
    if (chapters.length === 0) throw new Error(`${kind.toUpperCase()}: no content detected`);
    return buildEpubBytes(chapters, bookTitle);
  }
}
