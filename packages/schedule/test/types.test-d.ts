import { expectTypeOf, it } from "vitest"

import { defineSchedule, schedules } from "../src/index.ts"

it("infers schedule handler result types", () => {
  const schedule = defineSchedule("0 9 * * *", async context => context.id)

  expectTypeOf(schedule.handler).parameters.toEqualTypeOf<[{
    id: string
    scheduledAt: Date
  }]>()
  expectTypeOf(schedule.handler).returns.toEqualTypeOf<string | Promise<string>>()
})

it("types the defineSchedule helper signature", () => {
  defineSchedule("0 9 * * *", async (context) => {
    expectTypeOf(context.scheduledAt).toEqualTypeOf<Date>()
  }, { id: "daily-report" })

  // @ts-expect-error cron is required.
  defineSchedule(async () => {})

  // @ts-expect-error handler is required.
  defineSchedule("0 9 * * *")

  // @ts-expect-error options.id must be a string when provided.
  defineSchedule("0 9 * * *", () => {}, { id: 123 })

  // @ts-expect-error options.allowRuntimeSchedules must be a boolean when provided.
  defineSchedule("0 9 * * *", () => {}, { allowRuntimeSchedules: "yes" })
})

it("types Runtime Schedule helper inputs", async () => {
  await schedules.create({ cron: "0 9 * * *", target: "daily-report" })
  await schedules.update("schedule-1", { cron: "15 10 * * *", enabled: false, target: "daily-report" })

  // @ts-expect-error create requires a target.
  await schedules.create({ cron: "0 9 * * *" })

  // @ts-expect-error update enabled must be boolean.
  await schedules.update("schedule-1", { enabled: "yes" })
})
