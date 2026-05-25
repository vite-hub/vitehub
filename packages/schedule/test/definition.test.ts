import { describe, expect, it } from "vitest"

import { defineSchedule } from "../src/definition.ts"

describe("defineSchedule", () => {
  it("creates a cron Schedule Definition", () => {
    const handler = () => "ok"

    expect(defineSchedule("0 9 * * *", handler, { id: "daily-report" })).toEqual({
      cron: "0 9 * * *",
      handler,
      options: { id: "daily-report" },
    })
  })

  it("rejects invalid cron and handler inputs", () => {
    expect(() => defineSchedule("", () => {})).toThrow(/cron string/)
    expect(() => defineSchedule("0 9 * *", () => {})).toThrow(/five-field UTC cron/)
    expect(() => defineSchedule(" 0 9 * * *", () => {})).toThrow(/cron string/)
    expect(() => defineSchedule("0 9 * * *", "handler" as never)).toThrow(/schedule handler/)
    expect(() => defineSchedule("0 9 * * *", () => {}, [] as never)).toThrow(/plain object/)
    expect(() => defineSchedule("0 9 * * *", () => {}, { id: "" })).toThrow(/options.id/)
  })
})
