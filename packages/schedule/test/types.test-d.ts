import { expectTypeOf, it } from "vitest"

import { defineSchedule } from "../src/definition.ts"
import registry from "#vitehub/schedule/registry"
import type { ScheduleDefinitionRegistry } from "../src/types.ts"

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
})

it("types the generated schedule registry module", () => {
  expectTypeOf(registry).toEqualTypeOf<ScheduleDefinitionRegistry>()
})
