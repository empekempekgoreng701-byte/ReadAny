import { describe, expect, it } from "vitest";
import { selectRestoreTarget } from "./useChapterTranslation";

/**
 * Post-injection restore must prefer the book fraction: foliate fractions
 * derive from static section sizes, so they stay valid after injected
 * translation divs shift CFI child indices. Restoring a pre-injection CFI
 * systematically lands too early (upward jump proportional to the number of
 * injected divs above the anchor).
 */
describe("selectRestoreTarget", () => {
  it("prefers a valid book fraction over CFI", () => {
    expect(
      selectRestoreTarget({ fraction: 0.42, cfi: "epubcfi(/6/14!/4/2)" }),
    ).toEqual({ kind: "fraction", fraction: 0.42 });
  });

  it("falls back to CFI when no usable fraction exists", () => {
    expect(selectRestoreTarget({ fraction: 0, cfi: "epubcfi(/6/14!)" })).toEqual({
      kind: "cfi",
      cfi: "epubcfi(/6/14!)",
    });
    expect(selectRestoreTarget({ cfi: "epubcfi(/6/14!)" })).toEqual({
      kind: "cfi",
      cfi: "epubcfi(/6/14!)",
    });
    expect(selectRestoreTarget({ fraction: Number.NaN, cfi: "epubcfi(/6/14!)" })).toEqual({
      kind: "cfi",
      cfi: "epubcfi(/6/14!)",
    });
  });

  it("returns null when neither anchor is usable (fresh open at top needs no restore)", () => {
    expect(selectRestoreTarget({ fraction: 0 })).toBeNull();
    expect(selectRestoreTarget({})).toBeNull();
    expect(selectRestoreTarget({ fraction: undefined, cfi: "" })).toBeNull();
  });

  it("clamps out-of-range fractions instead of rejecting them", () => {
    const target = selectRestoreTarget({ fraction: 1 });
    expect(target?.kind).toBe("fraction");
    if (target?.kind === "fraction") {
      expect(target.fraction).toBeLessThan(1);
      expect(target.fraction).toBeGreaterThan(0);
    }
    expect(selectRestoreTarget({ fraction: -0.5, cfi: "epubcfi(/6/4!)" })).toEqual({
      kind: "cfi",
      cfi: "epubcfi(/6/4!)",
    });
  });
});
