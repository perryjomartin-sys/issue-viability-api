import { describe, it } from "node:test";
import { expect } from "./expect.ts";
import { ageInDays, daysBetween, maxIso, withinDays, ymd } from "../src/dates.ts";

const TODAY = new Date("2026-08-30T12:00:00Z");

describe("dates", () => {
  it("ymd truncates to a UTC calendar day", () => {
    expect(ymd(new Date("2026-08-30T23:59:59Z"))).toBe("2026-08-30");
    expect(ymd(new Date("2026-08-30T00:00:00Z"))).toBe("2026-08-30");
  });

  it("daysBetween counts whole UTC days and is signed", () => {
    expect(daysBetween(new Date("2026-08-20T00:00:00Z"), TODAY)).toBe(10);
    expect(daysBetween(TODAY, new Date("2026-08-20T00:00:00Z"))).toBe(-10);
  });

  it("withinDays is inclusive at the boundary and time-of-day independent", () => {
    expect(withinDays("2026-08-16T01:00:00Z", 14, TODAY)).toBe(true); // exactly 14 days
    expect(withinDays("2026-08-15T23:00:00Z", 14, TODAY)).toBe(false); // 15 days
  });

  it("withinDays treats missing/invalid dates as NOT within", () => {
    expect(withinDays(null, 14, TODAY)).toBe(false);
    expect(withinDays("not-a-date", 14, TODAY)).toBe(false);
  });

  it("withinDays treats future dates as within", () => {
    expect(withinDays("2026-09-05T00:00:00Z", 14, TODAY)).toBe(true);
  });

  it("ageInDays returns null for unparseable input", () => {
    expect(ageInDays("garbage", TODAY)).toBeNull();
    expect(ageInDays("2026-08-25T00:00:00Z", TODAY)).toBe(5);
  });

  it("maxIso returns the latest timestamp or null", () => {
    expect(maxIso("2026-01-01T00:00:00Z", "2026-08-01T00:00:00Z", null)).toBe(
      new Date("2026-08-01T00:00:00Z").toISOString(),
    );
    expect(maxIso(null, undefined, "bad")).toBeNull();
  });
});
