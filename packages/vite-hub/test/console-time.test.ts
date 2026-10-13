import { describe, expect, it } from "vitest"

import { recentTimestamp } from "../src/console/runtime/client/time.ts"

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
