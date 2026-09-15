/**
 * DOCX → EPUB round-trip test.
 *
 * Builds a minimal DOCX in memory (store-only ZIP via buildStoreOnlyZip),
 * converts it, then verifies the output is a valid EPUB containing the
 * expected chapter text and embedded image.
 */
import { describe, expect, it } from "vitest";
import { buildStoreOnlyZip } from "./store-only-zip";
import { DocxToEpubConverter } from "./docx-to-epub";
import { ZipReader, Uint8ArrayReader, Uint8ArrayWriter } from "@zip.js/zip.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// 1x1 red PNG (minimal valid PNG)
const RED_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02,
  0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44,
  0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x00, 0x03, 0x00,
  0x01, 0x00, 0x05, 0xfe, 0xd4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
  0xae, 0x42, 0x60, 0x82,
]);

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Chapter One</w:t></w:r></w:p>
    <w:p><w:r><w:t>Hello </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>bold world</w:t></w:r></w:p>
    <w:p><w:r><w:drawing><wp:inline><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill><a:blip r:embed="rId5"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Chapter Two</w:t></w:r></w:p>
    <w:p><w:r><w:t>Second chapter text.</w:t></w:r></w:p>
  </w:body>
</w:document>`;

const RELS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/pic1.png"/>
</Relationships>`;

const CORE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:title>Test Docx Book</dc:title>
  <dc:creator>Test Author</dc:creator>
</cp:coreProperties>`;

function buildDocx(): Uint8Array {
  return buildStoreOnlyZip([
    { name: "[Content_Types].xml", data: encoder.encode(CONTENT_TYPES) },
    { name: "word/document.xml", data: encoder.encode(DOCUMENT_XML) },
    { name: "word/_rels/document.xml.rels", data: encoder.encode(RELS_XML) },
    { name: "docProps/core.xml", data: encoder.encode(CORE_XML) },
    { name: "word/media/pic1.png", data: RED_PNG },
  ]);
}

function makeFile(bytes: Uint8Array, name = "test.docx"): File {
  return {
    name,
    size: bytes.byteLength,
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
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

async function zipHasEntry(bytes: Uint8Array, targetPath: string): Promise<boolean> {
  const reader = new ZipReader(new Uint8ArrayReader(bytes));
  try {
    const entries = await reader.getEntries();
    return entries.some(
      (e) => (e as unknown as { filename: string }).filename === targetPath,
    );
  } finally {
    await reader.close();
  }
}

describe("DocxToEpubConverter", () => {
  it("converts headings to chapters, keeps bold, embeds images", async () => {
    const conversion = await new DocxToEpubConverter().convertToBytes({
      file: makeFile(buildDocx()),
    });

    expect(conversion.bookTitle).toBe("Test Docx Book");
    expect(conversion.author).toBe("Test Author");
    expect(conversion.chapterCount).toBe(2);
    expect(conversion.epubBytes.length).toBeGreaterThan(1000);

    const ch1 = await readZipText(conversion.epubBytes, "OEBPS/chapter1.xhtml");
    expect(ch1).toContain("Chapter One");
    expect(ch1).toContain("<b>bold world</b>");
    expect(ch1).toContain('src="media/pic1.png"');

    expect(await zipHasEntry(conversion.epubBytes, "OEBPS/media/pic1.png")).toBe(true);

    const opf = await readZipText(conversion.epubBytes, "content.opf");
    expect(opf).toContain("media/pic1.png");
    expect(opf).toContain("image/png");
  });

  it("rejects non-ZIP input", async () => {
    const bad = new Uint8Array([1, 2, 3, 4]);
    await expect(
      new DocxToEpubConverter().convertToBytes({ file: makeFile(bad) }),
    ).rejects.toThrow(/ZIP/i);
  });
});
