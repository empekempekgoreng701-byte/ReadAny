import { describe, expect, it } from "vitest";
import { decodeXmlEntitiesOnce } from "./text-entities";

describe("decodeXmlEntitiesOnce", () => {
  it("decodes double-escaped metadata values", () => {
    expect(decodeXmlEntitiesOnce("&lt;unknown&gt;")).toBe("<unknown>");
    expect(decodeXmlEntitiesOnce("Fish &amp; Chips")).toBe("Fish & Chips");
  });

  it("decodes quotes and numeric references", () => {
    expect(decodeXmlEntitiesOnce("&quot;Hi&quot;")).toBe('"Hi"');
    expect(decodeXmlEntitiesOnce("&#65;&#x42;")).toBe("AB");
  });

  it("leaves plain text and invalid entities untouched", () => {
    expect(decodeXmlEntitiesOnce("Just text")).toBe("Just text");
    expect(decodeXmlEntitiesOnce("Tom & Jerry")).toBe("Tom & Jerry");
    expect(decodeXmlEntitiesOnce("&nope;")).toBe("&nope;");
    expect(decodeXmlEntitiesOnce("&#x110000;")).toBe("&#x110000;");
  });

  it("applies only a single pass", () => {
    // "&amp;lt;" -> "&lt;" (not "<"), so literal ampersands survive.
    expect(decodeXmlEntitiesOnce("&amp;lt;")).toBe("&lt;");
  });
});
