import { describe, expect, it } from "vitest";
import { enforceByteLimit, lruRecordDelete, lruRecordPut } from "./lru-record";

describe("lruRecordPut (tests R, S)", () => {
  it("inserts until the limit, then evicts least-recently-used", () => {
    let map: Record<string, string> = {};
    map = lruRecordPut(map, "a", "1", 3);
    map = lruRecordPut(map, "b", "2", 3);
    map = lruRecordPut(map, "c", "3", 3);
    expect(Object.keys(map)).toEqual(["a", "b", "c"]);
    map = lruRecordPut(map, "d", "4", 3);
    expect(Object.keys(map)).toEqual(["b", "c", "d"]);
    expect(map["a"]).toBeUndefined();
  });

  it("promotes hits so hot entries survive eviction", () => {
    let map: Record<string, string> = { a: "1", b: "2", c: "3" };
    const same = lruRecordPut(map, "c", "3", 3);
    expect(same).toBe(map);
    map = lruRecordPut(map, "a", "1x", 3);
    expect(Object.keys(map)).toEqual(["b", "c", "a"]);
    expect(map["a"]).toBe("1x");
    map = lruRecordPut(map, "d", "4", 3);
    expect(Object.keys(map)).toEqual(["c", "a", "d"]);
  });

  it("never exceeds the limit under churn", () => {
    let map: Record<string, string> = {};
    for (let i = 0; i < 500; i++) {
      map = lruRecordPut(map, `k${i % 7}`, `${i}`, 5);
    }
    expect(Object.keys(map).length).toBeLessThanOrEqual(5);
  });
});

describe("enforceByteLimit", () => {
  it("returns the same reference within budget", () => {
    const map = { a: "12345" };
    expect(enforceByteLimit(map, 10)).toBe(map);
  });

  it("evicts oldest-first until within budget", () => {
    const map = { a: "1234567890", b: "12345", c: "12345" };
    const next = enforceByteLimit(map, 12);
    expect(next).toEqual({ b: "12345", c: "12345" });
  });

  it("always keeps the newest entry even over budget", () => {
    const map = { a: "1", big: "x".repeat(100) };
    const next = enforceByteLimit(map, 10);
    expect(next).toEqual({ big: "x".repeat(100) });
  });
});

describe("lruRecordDelete (test S)", () => {
  it("removes keys and keeps reference when nothing matches", () => {
    const map = { a: "1", b: "2" };
    expect(lruRecordDelete(map, ["x"])).toBe(map);
    expect(lruRecordDelete(map, ["a"])).toEqual({ b: "2" });
  });
});
