import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import { invalidScheduleValueDetails } from "../src/errors.ts"

describe("Schedule error value details", () => {
  it("classifies a Date created in another realm as a date", () => {
    const value = runInNewContext("new Date('2026-01-02T03:04:05.000Z')")
    expect(invalidScheduleValueDetails("scheduledAt", value)).toEqual({ field: "scheduledAt", valueType: "date" })
  })
})
