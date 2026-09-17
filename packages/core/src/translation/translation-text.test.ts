import { describe, expect, it } from "vitest";
import {
  CJK_SCRIPT_RE,
  effectiveWholeWord,
  normalizeParagraphText,
  shouldBypassWholeWordForQuery,
} from "./translation-text";

describe("normalizeParagraphText", () => {
  it("collapses whitespace runs and trims (innerText approximation)", () => {
    expect(normalizeParagraphText("  hello   \n\t  world  ")).toBe("hello world");
    expect(normalizeParagraphText("line1\n        line2")).toBe("line1 line2");
  });
  it("is idempotent (no churn for well-formed text)", () => {
    const clean = "Already clean sentence with single spaces.";
    expect(normalizeParagraphText(clean)).toBe(clean);
    expect(normalizeParagraphText(normalizeParagraphText("  a  b  "))).toBe("a b");
  });
  it("handles empty input", () => {
    expect(normalizeParagraphText("")).toBe("");
    expect(normalizeParagraphText("   \n  ")).toBe("");
  });
});

describe("CJK whole-word bypass (test U)", () => {
  it("detects CJK scripts", () => {
    expect(CJK_SCRIPT_RE.test("Regresi Tanpa Akhir")).toBe(false);
    expect(CJK_SCRIPT_RE.test(" Regresi SMA")).toBe(false);
    expect(CJK_SCRIPT_RE.test("搜")).toBe(true);
    expect(CJK_SCRIPT_RE.test("lancel搜")).toBe(true);
    expect(CJK_SCRIPT_RE.test("ひらがな")).toBe(true);
    expect(CJK_SCRIPT_RE.test("한글")).toBe(true);
  });
  it("bypasses whole-word for CJK queries only", () => {
    expect(shouldBypassWholeWordForQuery("搜")).toBe(true);
    expect(shouldBypassWholeWordForQuery("lancel")).toBe(false);
    expect(shouldBypassWholeWordForQuery("")).toBe(false);
    expect(effectiveWholeWord(true, "搜")).toBe(false);
    expect(effectiveWholeWord(true, "lancel")).toBe(true);
    expect(effectiveWholeWord(false, "搜")).toBe(false);
  });
});
