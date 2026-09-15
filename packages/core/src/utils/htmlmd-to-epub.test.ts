/**
 * HTML / Markdown → EPUB round-trip test.
 */
import { describe, expect, it } from "vitest";
import { ZipReader, Uint8ArrayReader, Uint8ArrayWriter } from "@zip.js/zip.js";
import { HtmlMdToEpubConverter } from "./htmlmd-to-epub";

const decoder = new TextDecoder();

function makeFile(text: string, name: string, type: string): File {
  const bytes = new TextEncoder().encode(text);
  return {
    name,
    size: bytes.byteLength,
    type,
    arrayBuffer: () =>
      Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
  } as unknown as File;
}

async function readZipText(bytes: Uint8Array, targetPath: string): Promise<string | null> {
  const reader = new ZipReader(new Uint8ArrayReader(bytes));
  try {
    const entries = await reader.getEntries();
    for (const entry of entries) {
      const e = entry as unknown as {
        filename: string;
        getData?: (w: Uint8ArrayWriter) => Promise<Uint8Array>;
      };
      if (e.filename === targetPath && e.getData) {
        return decoder.decode(await e.getData(new Uint8ArrayWriter()));
      }
    }
    return null;
  } finally {
    await reader.close();
  }
}

describe("HtmlMdToEpubConverter", () => {
  it("converts HTML: title from <title>, h1 split, scripts stripped", async () => {
    const html = `<!DOCTYPE html><html><head><title>My HTML Book</title><script>alert(1)</script></head>
<body><h1>Part One</h1><p>First <b>paragraph</b>.</p><h1>Part Two</h1><p>Second.</p></body></html>`;
    const conversion = await new HtmlMdToEpubConverter().convertToBytes({
      file: makeFile(html, "book.html", "text/html"),
      kind: "html",
    });

    expect(conversion.bookTitle).toBe("My HTML Book");
    expect(conversion.chapterCount).toBe(2);
    const ch1 = await readZipText(conversion.epubBytes, "OEBPS/chapter1.xhtml");
    expect(ch1).toContain("Part One");
    expect(ch1).toContain("First");
    expect(ch1).not.toContain("alert(1)");
  });

  it("converts Markdown: headings, bold, list, code", async () => {
    const md = `# Big Title\n\nIntro para.\n\n## Section A\n\n- item one\n- item two\n\n\`\`\`\ncode()\n\`\`\`\n`;
    const conversion = await new HtmlMdToEpubConverter().convertToBytes({
      file: makeFile(md, "notes.md", "text/markdown"),
      kind: "markdown",
    });

    expect(conversion.bookTitle).toBe("Big Title");
    expect(conversion.chapterCount).toBeGreaterThanOrEqual(2);
    const ch1 = await readZipText(conversion.epubBytes, "OEBPS/chapter1.xhtml");
    expect(ch1).toContain("Intro para");
    const all = [1, 2, 3]
      .map((i) => i)
      .filter(() => true);
    void all;
    // list + code appear somewhere in the book
    let foundList = false;
    let foundCode = false;
    for (let i = 1; i <= conversion.chapterCount; i++) {
      const ch = await readZipText(conversion.epubBytes, `OEBPS/chapter${i}.xhtml`);
      if (ch?.includes("<li>")) foundList = true;
      if (ch?.includes("<pre>")) foundCode = true;
    }
    expect(foundList).toBe(true);
    expect(foundCode).toBe(true);
  });

  it("rejects empty input", async () => {
    await expect(
      new HtmlMdToEpubConverter().convertToBytes({
        file: makeFile("   ", "empty.md", "text/markdown"),
        kind: "markdown",
      }),
    ).rejects.toThrow(/empty/i);
  });
});
