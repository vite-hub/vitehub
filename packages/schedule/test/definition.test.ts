import { describe, expect, it } from "vitest"

import { defineSchedule, defineScheduleTarget } from "../src/definition.ts"

describe("defineSchedule", () => {
  it("creates a cron Schedule Definition", () => {
    const handler = () => "ok"

    expect(defineSchedule({ cron: "0 9 * * *", handler })).toEqual({
      cron: "0 9 * * *",
      handler,
    })
  })

  it("rejects invalid definition inputs", () => {
    expect(() => defineSchedule(undefined as never)).toThrow(/expects an object/)
    expect(() => defineSchedule({ cron: "", handler: () => {} })).toThrow(/cron string/)
    expect(() => defineSchedule({ cron: "0 9 * *", handler: () => {} })).toThrow(/five-field UTC cron/)
    expect(() => defineSchedule({ cron: " 0 9 * * *", handler: () => {} })).toThrow(/cron string/)
    expect(() => defineSchedule({ cron: "0 9 * * *", handler: "handler" as never })).toThrow(/schedule handler/)
    expect(() => defineSchedule({ cron: "0 9 * * *", handler: () => {}, id: "daily" } as never)).toThrow(/does not support the "id" option/)
    expect(() => defineSchedule({ cron: "0 9 * * *", handler: () => {}, timeZone: "Europe/Copenhagen" } as never)).toThrow(/does not support the "timeZone" option/)
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
