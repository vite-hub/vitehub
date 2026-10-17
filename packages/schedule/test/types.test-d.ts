import { expectTypeOf, it } from "vitest"

import { defineSchedule } from "../src/index.ts"
import { executeStaticSchedule } from "../src/runtime.ts"
import { hubSchedule } from "../src/vite.ts"
import "../src/runtime.ts"
import registry from "#vitehub/schedule/registry"
import type { ScheduleDefinitionRegistry, ScheduleRunStore } from "../src/types.ts"

import type { ScheduleRunContext } from "../src/index.ts"

it("infers schedule handler result types", () => {
  const schedule = defineSchedule({ cron: "0 9 * * *", handler: async context => context.id })

  expectTypeOf(schedule.handler).parameters.toEqualTypeOf<[ScheduleRunContext]>()
  expectTypeOf(schedule.handler).returns.toEqualTypeOf<string | Promise<string>>()
})

it("types the defineSchedule helper signature", () => {
  defineSchedule({
    cron: "0 9 * * *",
    manual: true,
    handler: async (context) => {
      expectTypeOf(context.scheduledAt).toEqualTypeOf<Date>()
      expectTypeOf(context.waitUntil).toEqualTypeOf<(promise: PromiseLike<unknown>) => void>()
      context.waitUntil(Promise.resolve())
    },
  })

  const positional = defineSchedule("0 9 * * *", async context => context.id, { manual: true })
  expectTypeOf(positional.options).toEqualTypeOf<{ manual?: boolean } | undefined>()

  // @ts-expect-error cron is required.
  defineSchedule({ handler: async () => {} })

  // @ts-expect-error handler is required.
  defineSchedule({ cron: "0 9 * * *" })

  // @ts-expect-error id is not a schedule definition option.
  defineSchedule({ cron: "0 9 * * *", handler: () => {}, id: "daily-report" })

  // @ts-expect-error manual must be a boolean when provided.
  defineSchedule({ cron: "0 9 * * *", handler: () => {}, manual: "yes" })

  // @ts-expect-error Runtime Schedules were removed.
  defineSchedule({ cron: "0 9 * * *", handler: () => {}, allowRuntimeSchedules: true })

  // @ts-expect-error Static Schedule Definitions remain UTC-only.
  defineSchedule({ cron: "0 9 * * *", handler: () => {}, timeZone: "Europe/Copenhagen" })
})

it("types host waitUntil for Static Schedule execution", async () => {
  const waitUntil = (promise: PromiseLike<unknown>) => { void promise }

  await executeStaticSchedule({
    cron: "0 9 * * *",
    definition: defineSchedule({ cron: "0 9 * * *", handler: async () => {} }),
    name: "daily-report",
    waitUntil,
  })
})

it("types the generated schedule registry module", () => {
  expectTypeOf(registry).toEqualTypeOf({} as ScheduleDefinitionRegistry)
})

