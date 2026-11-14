import { describe, expect, it } from "vitest"

import { defineSchedule } from "../src/definition.ts"

describe("defineSchedule", () => {
  it("creates a cron Schedule Definition", () => {
    const handler = () => "ok"

    expect(defineSchedule({ cron: "0 9 * * *", handler })).toEqual({
      cron: "0 9 * * *",
      handler,
    })
  })

  it("keeps the options of the object form", () => {
    const handler = () => "ok"
    expect(defineSchedule({ cron: "0 9 * * *", handler })).toEqual({ cron: "0 9 * * *", handler })
    expect(defineSchedule({ cron: "0 9 * * *", manual: true, handler }))
      .toEqual({ cron: "0 9 * * *", handler, options: { manual: true } })
    expect(() => defineSchedule({ cron: "0 9 * * *", manual: "yes", handler } as never)).toThrow(/manual must be a boolean/)
  })

  it("names the object form when a caller passes the removed positional form", () => {
    const removed = defineSchedule as unknown as (...args: unknown[]) => unknown
    for (const args of [["0 9 * * *", () => "ok"], ["0 9 * * *", () => "ok", { manual: true }], [{ cron: "0 9 * * *", handler: () => "ok" }, { manual: true }]]) {
      expect(() => removed(...args)).toThrow(expect.objectContaining({
        code: "SCHEDULE_C0007",
        message: expect.stringContaining("`defineSchedule({ cron: \"0 9 * * *\", handler })`"),
      }))
    }
  })

  it("rejects invalid definition inputs", () => {
    expect(() => defineSchedule(undefined as never)).toThrow(/expects an object/)
    expect(() => defineSchedule({ cron: "", handler: () => {} })).toThrow(/cron string/)
    expect(() => defineSchedule({ cron: "0 9 * *", handler: () => {} })).toThrow(/five-field cron expression/)
    expect(() => defineSchedule({ cron: " 0 9 * * *", handler: () => {} })).toThrow(/cron string/)
    expect(() => defineSchedule({ cron: "0 9 * * *", handler: "handler" as never })).toThrow(/schedule handler/)
    expect(() => defineSchedule({ cron: "0 9 * * *", handler: () => {}, id: "daily" } as never)).toThrow(/does not support the "id" option/)
    expect(() => defineSchedule({ allowRuntimeSchedules: true, cron: "0 9 * * *", handler: () => {} } as never)).toThrow(/does not support the "allowRuntimeSchedules" option/)
  })

  it("keeps a declared IANA time zone", () => {
    const handler = () => "ok"
    expect(defineSchedule({ cron: "0 8 * * *", handler, timeZone: "Europe/Madrid" })).toEqual({ cron: "0 8 * * *", handler, timeZone: "Europe/Madrid" })
    expect(defineSchedule({ cron: "0 8 * * *", manual: true, timeZone: "Europe/Madrid", handler }))
      .toEqual({ cron: "0 8 * * *", handler, options: { manual: true }, timeZone: "Europe/Madrid" })
    expect(defineSchedule({ cron: "0 8 * * *", handler, timeZone: "UTC" })).toEqual({ cron: "0 8 * * *", handler, timeZone: "UTC" })
  })

  it("rejects a time zone that is not an IANA name", () => {
    for (const timeZone of ["PST", "Europe/Atlantis", "", " Europe/Madrid", 1]) {
      expect(() => defineSchedule({ cron: "0 8 * * *", handler: () => {}, timeZone } as never)).toThrow(/timeZone must be an IANA time zone/)
    }
    expect(() => defineSchedule({ cron: "0 8 * * *", timeZone: "PST", handler: () => {} })).toThrow(/timeZone must be an IANA time zone/)
  })
})
