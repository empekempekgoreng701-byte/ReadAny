import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Test W: every i18n key used by the Book Overview must exist in the English
 * locale (fallback language). Missing keys surface raw Chinese defaultValue
 * text in the UI — the exact bug class this guards against.
 */
const OVERVIEW_KEYS = [
  "title",
  "noCover",
  "readProgress",
  "chapterCount",
  "translationProgress",
  "continueReading",
  "startReading",
  "pauseTranslation",
  "resumeTranslation",
  "translateBook",
  "searchBook",
  "chapters",
  "sortAsc",
  "sortDesc",
  "filterAll",
  "filterTranslated",
  "filterUntranslated",
  "translated",
  "notTranslated",
  "translating",
  "partial",
  "translationError",
  "lastRead",
  "loadFailed",
  "retry",
  "noChapters",
];

const LIBRARY_KEYS = ["unknownBook"];

function readEnLocale(file: string): Record<string, unknown> {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = resolve(here, "..", "i18n", "locales", "en", file);
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

describe("book overview i18n coverage (test W)", () => {
  it("defines every overview key in English", () => {
    const library = readEnLocale("library.json") as {
      overview?: Record<string, string>;
    };
    expect(library.overview, "missing 'overview' section in en/library.json").toBeDefined();
    for (const key of OVERVIEW_KEYS) {
      expect(typeof library.overview?.[key], `overview.${key}`).toBe("string");
    }
  });

  it("defines supporting library keys in English", () => {
    const library = readEnLocale("library.json") as {
      library?: Record<string, string>;
    };
    for (const key of LIBRARY_KEYS) {
      expect(typeof library.library?.[key], `library.${key}`).toBe("string");
    }
  });
});
