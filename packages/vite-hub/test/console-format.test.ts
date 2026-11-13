import { describe, expect, it } from "vitest"

import { consoleBytes, consoleDayTime, consoleDuration, consoleDurationWords, consoleInitials, consoleNumber, consoleStatusValue, consoleTimeOfDay, consoleValueParts } from "../src/console/runtime/client/format"

describe("Console display helpers", () => {
  it("formats sizes in powers of 1024 with one unit name everywhere", () => {
    expect(consoleBytes(0)).toBe("0 B")
    expect(consoleBytes(1023)).toBe("1023 B")
    expect(consoleBytes(1536)).toBe("1.5 KB")
    expect(consoleBytes(11_776)).toBe("12 KB")
    expect(consoleBytes(256 * 1024)).toBe("256 KB")
    expect(consoleBytes(10 * 1024 * 1024)).toBe("10 MB")
    expect(consoleBytes(3 * 1024 ** 4)).toBe("3 TB")
    expect(consoleBytes(Number.NaN)).toBe("Unknown")
  })

  it("splits owner text into text and timestamps", () => {
    expect(consoleValueParts("succeeded at 2026-10-15T11:00:00.000Z")).toEqual([
      { kind: "text", value: "succeeded at " },
      { kind: "time", value: "2026-10-15T11:00:00.000Z" },
    ])
    expect(consoleValueParts("2026-10-15T11:00:00.000Z (not automatic)")).toEqual([
      { kind: "time", value: "2026-10-15T11:00:00.000Z" },
      { kind: "text", value: " (not automatic)" },
    ])
    expect(consoleValueParts("Use `vitehub schedule runs a` at 2026-10-15T11:00:00.000Z.")).toEqual([
      { kind: "text", value: "Use " },
      { kind: "code", value: "vitehub schedule runs a" },
      { kind: "text", value: " at " },
      { kind: "time", value: "2026-10-15T11:00:00.000Z" },
      { kind: "text", value: "." },
    ])
    // A date without a time stays text, and so does an impossible timestamp.
    expect(consoleValueParts("2026-10-15")).toEqual([{ kind: "text", value: "2026-10-15" }])
    expect(consoleValueParts("2026-13-45T99:99Z")).toEqual([{ kind: "text", value: "2026-13-45T99:99Z" }])
  })

  it("reads whole status words with a neutral label", () => {
    expect(consoleStatusValue("Enabled")).toEqual({ label: "Enabled", tone: "success" })
    expect(consoleStatusValue("failed")).toEqual({ label: "Failed", tone: "error" })
    expect(consoleStatusValue("running")).toEqual({ label: "Running", pending: true, tone: "neutral" })
    expect(consoleStatusValue("Sent")).toEqual({ label: "Sent", tone: "success" })
    expect(consoleStatusValue("Captured only")).toEqual({ label: "Captured only", tone: "neutral" })
    expect(consoleStatusValue("Provider")).toBeUndefined()
    expect(consoleStatusValue("Not enabled")).toBeUndefined()
  })

  it("formats durations on one scale, with whole seconds for a session", () => {
    expect(consoleDuration(0.4)).toBe("<1ms")
    expect(consoleDuration(480)).toBe("480ms")
    expect(consoleDuration(41_200)).toBe("41.2s")
    expect(consoleDuration(59_500, { wholeSeconds: true })).toBe("1m 0s")
    expect(consoleDuration(128_000)).toBe("2m 8s")
    expect(consoleDuration(4_800_000)).toBe("1h 20m")
    expect(consoleDuration(-1)).toBeUndefined()
    expect(consoleDurationWords(5_400)).toBe("1 hour 30 minutes")
  })

  it("formats counts, times of day, and initials in English", () => {
    expect(consoleNumber(1234)).toBe("1,234")
    expect(consoleTimeOfDay(undefined)).toBe("")
    expect(consoleTimeOfDay("nope")).toBe("")
    expect(consoleTimeOfDay("2026-10-20T09:05:00Z")).toMatch(/^\d{2}:\d{2} [AP]M$/)
    expect(consoleDayTime("2026-10-20T09:05:00Z")).toMatch(/^Oct \d{1,2}, \d{2}:\d{2}$/)
    expect(consoleInitials("Ada Lovelace")).toBe("AL")
    expect(consoleInitials("ada.byron@example.com")).toBe("AB")
    expect(consoleInitials("Lucía")).toBe("LU")
    expect(consoleInitials("")).toBe("?")
  })
})
