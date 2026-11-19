import { describe, expect, it, vi } from "vitest"

import { parseDuration } from "../src/index.ts"

describe("parseDuration()", () => {
  it.each([
    ["250ms", 250],
    ["1.5s", 1_500],
    ["2.007 seconds", 2_007],
    ["4.15m", 249_000],
    ["2.175m", 130_500],
    ["0.0175 days", 1_512_000],
    ["0.00001s", 0.01],
    ["30 seconds", 30_000],
    ["5m", 300_000],
    ["2 hours", 7_200_000],
    ["1 day", 86_400_000],
    ["2w", 1_209_600_000],
    ["0s", 0],
  ] as const)("reads %j as %d milliseconds", (value, milliseconds) => {
    expect(parseDuration(value)).toBe(milliseconds)
  })

  it("ignores the case of the unit and space around the value", () => {
    expect(parseDuration(" 2 Hours " as never)).toBe(7_200_000)
  })

  it.each(["-1s", "soon", "10", "1 month", "1 constructor", "", "1e3s", `${"9".repeat(400)}s`])("rejects %j with RUNTIME_DURATION_INVALID", (value) => {
    expect(() => parseDuration(value as never)).toThrow(expect.objectContaining({ code: "RUNTIME_DURATION_INVALID" }))
  })

  it("shows the string form of a number in the fix and names the option", () => {
    expect(() => parseDuration(300_000 as never, "debounce")).toThrow(expect.objectContaining({
      code: "RUNTIME_DURATION_INVALID",
      fix: expect.stringContaining("\"5m\""),
      why: expect.stringContaining("`debounce`"),
    }))
    expect(() => parseDuration(1_500 as never)).toThrow(expect.objectContaining({ fix: expect.stringContaining("\"1500ms\"") }))
  })

  it("does not convert an object to name it", () => {
    const toPrimitive = vi.fn(() => "1s")
    expect(() => parseDuration({ [Symbol.toPrimitive]: toPrimitive } as never)).toThrow(expect.objectContaining({ why: expect.stringContaining("an object") }))
    expect(toPrimitive).not.toHaveBeenCalled()
  })
})
