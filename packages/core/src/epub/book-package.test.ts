import { BlobWriter, TextReader, ZipWriter } from "@zip.js/zip.js";
import { describe, expect, it } from "vitest";
import { extractParagraphsFromXhtml, openEpubPackage } from "./book-package";

const CONTAINER_XML = `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;

const CONTENT_OPF = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Test Book</dc:title><dc:creator>Author</dc:creator><dc:language>en</dc:language></metadata>
<manifest>
<item id="cover" href="Text/cover.xhtml" media-type="application/xhtml+xml"/>
<item id="ch1" href="Text/ch01.xhtml" media-type="application/xhtml+xml"/>
<item id="ch2" href="Text/ch02.xhtml" media-type="application/xhtml+xml"/>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
</manifest>
<spine>
<itemref idref="cover" linear="no"/>
<itemref idref="ch1"/>
<itemref idref="ch2"/>
</spine>
</package>`;

const NAV_XHTML = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>
<nav epub:type="toc"><ol>
<li><a href="Text/ch01.xhtml">Chapter 1: Beginnings</a></li>
<li><a href="Text/ch02.xhtml">Chapter 2: Continuation</a></li>
</ol></nav>
</body></html>`;

const COVER_XHTML = `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><div><img src="cover.jpg" alt="cover"/></div></body></html>`;

const CH1_XHTML = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body>
<h1>Chapter 1: Beginnings</h1>
<p>
  First   paragraph with
  messy whitespace.
</p>
<p>x</p>
<p>Second paragraph.</p>
</body></html>`;

const CH2_XHTML = `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>Only paragraph.</p></body></html>`;

async function buildTestEpubBytes(): Promise<Uint8Array> {
  const writer = new ZipWriter(new BlobWriter("application/epub+zip"));
  const files: Record<string, string> = {
    mimetype: "application/epub+zip",
    "META-INF/container.xml": CONTAINER_XML,
    "OEBPS/content.opf": CONTENT_OPF,
    "OEBPS/nav.xhtml": NAV_XHTML,
    "OEBPS/Text/cover.xhtml": COVER_XHTML,
    "OEBPS/Text/ch01.xhtml": CH1_XHTML,
    "OEBPS/Text/ch02.xhtml": CH2_XHTML,
  };
  for (const [name, text] of Object.entries(files)) {
    await writer.add(name, new TextReader(text));
  }
  const blob = await writer.close();
  const buffer = await blob.arrayBuffer();
  return new Uint8Array(buffer);
}

describe("extractParagraphsFromXhtml", () => {
  it("mirrors the WebView extractor (ids, filter, normalization)", () => {
    const paras = extractParagraphsFromXhtml(CH1_XHTML);
    // h1(0) + first p(1) + second p(3); single-char <p>x</p>(2) skipped but keeps its index.
    expect(paras.map((p) => p.id)).toEqual(["para_0", "para_1", "para_3"]);
    expect(paras[0]).toMatchObject({ tagName: "h1", text: "Chapter 1: Beginnings" });
    // Whitespace collapsed exactly like innerText.
    expect(paras[1]?.text).toBe("First paragraph with messy whitespace.");
    expect(paras[2]).toMatchObject({ tagName: "p", text: "Second paragraph." });
  });
  it("returns [] for invalid markup", () => {
    expect(extractParagraphsFromXhtml("not xml at all <>>")).toEqual([]);
  });
});

describe("openEpubPackage", () => {
  it("lists spine chapters with TOC titles and sizes", async () => {
    const handle = await openEpubPackage(await buildTestEpubBytes());
    try {
      expect(handle.chapters).toHaveLength(3);
      // Full spine incl. linear="no" cover keeps reader sectionIndex alignment.
      expect(handle.chapters[0]).toMatchObject({ sectionIndex: 0 });
      expect(handle.chapters[1]).toMatchObject({
        sectionIndex: 1,
        href: "OEBPS/Text/ch01.xhtml",
        title: "Chapter 1: Beginnings",
      });
      expect(handle.chapters[2]).toMatchObject({
        sectionIndex: 2,
        title: "Chapter 2: Continuation",
      });
      for (const ch of handle.chapters) {
        expect(typeof ch.sizeBytes === "number" && (ch.sizeBytes as number) > 0).toBe(true);
      }
      const xhtml = await handle.readSectionXhtml("OEBPS/Text/ch02.xhtml");
      expect(xhtml).toContain("Only paragraph.");
      expect(await handle.readSectionXhtml("OEBPS/Text/missing.xhtml")).toBeNull();
    } finally {
      await handle.close();
    }
  });
});
