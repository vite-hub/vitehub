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

  it("creates a positional definition and preserves options", () => {
    const handler = () => "ok"
    expect(defineSchedule("0 9 * * *", handler)).toEqual({ cron: "0 9 * * *", handler })
    expect(defineSchedule("0 9 * * *", handler, { manual: true }))
      .toEqual({ cron: "0 9 * * *", handler, options: { manual: true } })
    expect(() => defineSchedule("0 9 * * *", handler, { manual: "yes" } as never)).toThrow(/manual must be a boolean/)
    expect(() => defineSchedule("0 9 * * *", handler, null as never)).toThrow(/options must be an object/)
  })

  it("rejects invalid definition inputs", () => {
    expect(() => defineSchedule(undefined as never)).toThrow(/expects an object/)
    expect(() => defineSchedule({ cron: "", handler: () => {} })).toThrow(/cron string/)
    expect(() => defineSchedule({ cron: "0 9 * *", handler: () => {} })).toThrow(/five-field cron expression/)
    expect(() => defineSchedule({ cron: " 0 9 * * *", handler: () => {} })).toThrow(/cron string/)
    expect(() => defineSchedule({ cron: "0 9 * * *", handler: "handler" as never })).toThrow(/schedule handler/)
    expect(() => defineSchedule({ cron: "0 9 * * *", handler: () => {}, id: "daily" } as never)).toThrow(/does not support the "id" option/)
  })

  it("keeps a declared IANA time zone", () => {
    const handler = () => "ok"
    expect(defineSchedule({ cron: "0 8 * * *", handler, timeZone: "Europe/Madrid" })).toEqual({ cron: "0 8 * * *", handler, timeZone: "Europe/Madrid" })
    expect(defineSchedule("0 8 * * *", handler, { manual: true, timeZone: "Europe/Madrid" }))
      .toEqual({ cron: "0 8 * * *", handler, options: { manual: true }, timeZone: "Europe/Madrid" })
    expect(defineSchedule({ cron: "0 8 * * *", handler, timeZone: "UTC" })).toEqual({ cron: "0 8 * * *", handler, timeZone: "UTC" })
  })

  it("rejects a time zone that is not an IANA name", () => {
    for (const timeZone of ["PST", "Europe/Atlantis", "", " Europe/Madrid", 1]) {
      expect(() => defineSchedule({ cron: "0 8 * * *", handler: () => {}, timeZone } as never)).toThrow(/timeZone must be an IANA time zone/)
    }
    expect(() => defineSchedule("0 8 * * *", () => {}, { timeZone: "PST" })).toThrow(/timeZone must be an IANA time zone/)
  })
})

describe("defineScheduleTarget", () => {
  it("creates a cronless Runtime Schedule target", () => {
    const handler = () => "ok"

    expect(defineScheduleTarget({ handler })).toEqual({
      handler,
      options: { allowRuntimeSchedules: true },
    })
  })

  it("rejects invalid target inputs", () => {
    expect(() => defineScheduleTarget(undefined as never)).toThrow(/expects an object/)
    expect(() => defineScheduleTarget({ handler: "handler" as never })).toThrow(/schedule handler/)
    expect(() => defineScheduleTarget({ cron: "0 9 * * *", handler: () => {} } as never)).toThrow(/does not support the "cron" option/)
  })
})
