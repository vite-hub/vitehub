import { describe, expect, it } from "vitest"

import { consoleBytes, consoleStatusValue, consoleValueParts } from "../src/console/runtime/client/format"

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
    expect(consoleStatusValue("Provider")).toBeUndefined()
    expect(consoleStatusValue("Not enabled")).toBeUndefined()
  })
})
