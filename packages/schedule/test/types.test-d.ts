import { expectTypeOf, it } from "vitest"

import { defineSchedule, defineScheduleTarget, schedules } from "../src/index.ts"
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

  // @ts-expect-error Static Schedule Definitions remain UTC-only.
  defineSchedule({ cron: "0 9 * * *", handler: () => {}, timeZone: "Europe/Copenhagen" })
})

it("types cronless Runtime Schedule targets", () => {
  const target = defineScheduleTarget<{ prompt: string }>({
    handler: async (context) => {
      expectTypeOf(context.input).toEqualTypeOf<{ prompt: string } | undefined>()
      return context.input?.prompt
    },
  })

  expectTypeOf(target.handler).parameters.toEqualTypeOf<[ScheduleRunContext<{ prompt: string }>]>()

  // @ts-expect-error handler is required.
  defineScheduleTarget({})

  // @ts-expect-error cron belongs to defineSchedule, not defineScheduleTarget.
  defineScheduleTarget({ cron: "0 9 * * *", handler: () => {} })
})

it("types Runtime Schedule helper inputs", async () => {
  const created = await schedules.create({ cron: "0 9 * * *", input: { prompt: "Daily report" }, target: "daily-report", timeZone: "Europe/Copenhagen" })
  expectTypeOf(created.input).toEqualTypeOf<{ prompt: string } | undefined>()
  const updated = await schedules.update("schedule-1", { cron: "15 10 * * *", enabled: false, input: { prompt: "Weekday report" }, target: "daily-report", timeZone: "Asia/Bangkok" })
  expectTypeOf(updated.input).toEqualTypeOf<{ prompt: string } | undefined>()

  // @ts-expect-error create requires a target.
  await schedules.create({ cron: "0 9 * * *" })

  // @ts-expect-error update enabled must be boolean.
  await schedules.update("schedule-1", { enabled: "yes" })

  // @ts-expect-error update timeZone must be a string.
  await schedules.update("schedule-1", { timeZone: 123 })
})

it("types the generated schedule registry module", () => {
  expectTypeOf(registry).toEqualTypeOf({} as ScheduleDefinitionRegistry)
})
