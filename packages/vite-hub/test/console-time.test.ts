import { describe, expect, it } from "vitest"

import { dayLabel, exactTimestamps, recentTimestamp } from "../src/console/runtime/client/time.ts"

describe("recentTimestamp", () => {
  const now = Date.parse("2026-10-06T12:00:00.000Z")

  it("uses relative labels within one day and a UTC date after that", () => {
    expect(recentTimestamp("2026-10-06T11:59:30.000Z", now)).toBe("now")
    expect(recentTimestamp("2026-10-06T11:55:00.000Z", now)).toBe("5m ago")
    expect(recentTimestamp("2026-10-06T09:00:00.000Z", now)).toBe("3h ago")
    expect(recentTimestamp("2026-08-30T15:42:31.000Z", now)).toBe("Aug 30")
  })

  it("treats future timestamps as now and rejects invalid values", () => {
    expect(recentTimestamp("2026-10-06T12:05:00.000Z", now)).toBe("now")
    expect(recentTimestamp("not a date", now)).toBeUndefined()
  })
})

describe("dayLabel and exactTimestamps", () => {
  const now = Date.parse("2026-10-06T12:00:00.000Z")

  it("names days relative to now in the given time zone", () => {
    expect(dayLabel("2026-10-06T00:30:00.000Z", now, "UTC")).toBe("Today")
    expect(dayLabel("2026-10-05T23:30:00.000Z", now, "UTC")).toBe("Yesterday")
    // The same instant is already today two hours east of UTC.
    expect(dayLabel("2026-10-05T23:30:00.000Z", now, "Europe/Madrid")).toBe("Today")
    expect(dayLabel("2026-09-28T10:00:00.000Z", now, "UTC")).toBe("Sep 28")
    expect(dayLabel("2025-09-28T10:00:00.000Z", now, "UTC")).toBe("Sep 28, 2025")
    expect(dayLabel("nope", now, "UTC")).toBeUndefined()
  })

  it("shows the exact time in UTC and in the viewer zone", () => {
    expect(exactTimestamps("2026-10-06T09:05:03.000Z", "Europe/Madrid")).toEqual({
      local: "Oct 6, 2026, 11:05:03 GMT+2",
      utc: "Oct 6, 2026, 09:05:03 UTC",
    })
    expect(exactTimestamps("nope")).toBeUndefined()
  })
})
