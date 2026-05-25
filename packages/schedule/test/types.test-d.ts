import { expectTypeOf, it } from "vitest"

import { defineSchedule, schedules } from "../src/index.ts"
import "../src/runtime.ts"
import registry from "#vitehub/schedule/registry"
import type { ScheduleDefinitionRegistry } from "../src/types.ts"

import type { ScheduleRunContext } from "../src/index.ts"

it("infers schedule handler result types", () => {
  const schedule = defineSchedule({ cron: "0 9 * * *", handler: async context => context.id })

  expectTypeOf(schedule.handler).parameters.toEqualTypeOf<[ScheduleRunContext]>()
  expectTypeOf(schedule.handler).returns.toEqualTypeOf<string | Promise<string>>()
})

it("types the defineSchedule helper signature", () => {
  defineSchedule({
    cron: "0 9 * * *",
    handler: async (context) => {
      expectTypeOf(context.scheduledAt).toEqualTypeOf<Date>()
    },
  })

  // @ts-expect-error cron is required.
  defineSchedule({ handler: async () => {} })

  // @ts-expect-error handler is required.
  defineSchedule({ cron: "0 9 * * *" })

  // @ts-expect-error id is not a schedule definition option.
  defineSchedule({ cron: "0 9 * * *", handler: () => {}, id: "daily-report" })

  // @ts-expect-error allowRuntimeSchedules must be a boolean when provided.
  defineSchedule({ cron: "0 9 * * *", handler: () => {}, allowRuntimeSchedules: "yes" })
})

it("types Runtime Schedule helper inputs", async () => {
  await schedules.create({ cron: "0 9 * * *", target: "daily-report" })
  await schedules.update("schedule-1", { cron: "15 10 * * *", enabled: false, target: "daily-report" })

  // @ts-expect-error create requires a target.
  await schedules.create({ cron: "0 9 * * *" })

  // @ts-expect-error update enabled must be boolean.
  await schedules.update("schedule-1", { enabled: "yes" })
})

it("types the generated schedule registry module", () => {
  expectTypeOf(registry).toEqualTypeOf({} as ScheduleDefinitionRegistry)
})
