import { describe, expect, it } from "vitest";
import { buildIcs, escapeText, foldLine, isValidLocalDate, isValidLocalTime, suggestSlot } from "./ics";

const NOW = new Date("2026-11-11T15:04:05.123Z");

describe("ics", () => {
  it("escapes RFC 5545 text", () => {
    expect(escapeText("a,b;c\\d\ne")).toBe("a\\,b\\;c\\\\d\\ne");
  });

  it("folds long lines at 75 octets with a leading space", () => {
    const line = `SUMMARY:${"x".repeat(150)}`;
    const folded = foldLine(line);
    const parts = folded.split("\r\n");
    expect(parts[0]).toHaveLength(75);
    expect(parts.slice(1).every((p) => p.startsWith(" ") && p.length <= 75)).toBe(true);
    expect(parts.map((p, i) => (i ? p.slice(1) : p)).join("")).toBe(line);
    expect(foldLine("SHORT:1")).toBe("SHORT:1");
  });

  it("does not split a multi-byte character when folding", () => {
    const line = `SUMMARY:${"é".repeat(60)}`;
    const parts = foldLine(line).split("\r\n");
    for (const p of parts) expect(new TextEncoder().encode(p).length).toBeLessThanOrEqual(75);
    expect(parts.map((p, i) => (i ? p.slice(1) : p)).join("")).toBe(line);
  });

  it("builds one floating-time event with an alarm", () => {
    const ics = buildIcs({
      uid: "u1@novus.local",
      date: "2026-11-12",
      time: "23:30",
      durationMinutes: 45,
      summary: "Novus: Tailor your resume",
      location: "Library, 2nd floor",
      alarmMinutesBefore: 15,
      now: NOW,
    });
    expect(ics.endsWith("\r\n")).toBe(true);
    expect(ics).toContain("DTSTART:20261112T233000\r\n");
    expect(ics).toContain("DTEND:20261113T001500\r\n"); // crosses midnight
    expect(ics).toContain("DTSTAMP:20261111T150405Z\r\n");
    expect(ics).toContain("LOCATION:Library\\, 2nd floor");
    expect(ics).toContain("TRIGGER:-PT15M");
    expect(ics).not.toContain("TZID");
    expect(ics.split("\r\n").filter((l) => l === "BEGIN:VEVENT")).toHaveLength(1);
  });

  it("rejects invalid dates and times", () => {
    expect(isValidLocalDate("2026-02-30")).toBe(false);
    expect(isValidLocalDate("2026-11-12")).toBe(true);
    expect(isValidLocalTime("24:00")).toBe(false);
    expect(isValidLocalTime("09:05")).toBe(true);
    expect(() => buildIcs({ uid: "x", date: "2026-13-01", time: "10:00", durationMinutes: 30, summary: "x", now: NOW })).toThrow("invalid_date_or_time");
  });

  it("suggests tomorrow at 17:00", () => {
    expect(suggestSlot(NOW)).toEqual({ date: "2026-11-12", time: "17:00" });
  });
});
