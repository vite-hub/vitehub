import { expectTypeOf, it } from "vitest"

import { defineSchedule } from "../src/index.ts"
import { executeStaticSchedule } from "../src/runtime.ts"
import { installProcessScheduleRuntime } from "../src/runtime/process.ts"
import { hubSchedule } from "../src/vite.ts"
import "../src/runtime.ts"
import registry from "#vitehub/schedule/registry"
import type { ProcessScheduleRuntimeOptions, ScheduleRuntimeController } from "../src/runtime/process.ts"
import type { ScheduleProcessRuntimeOptions } from "../src/vite.ts"
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

  expectTypeOf(defineSchedule({ cron: "0 9 * * *", handler: () => {}, timeZone: "Europe/Copenhagen" }).timeZone).toEqualTypeOf<string | undefined>()
  defineSchedule("0 9 * * *", () => {}, { timeZone: "Europe/Copenhagen" })

  // @ts-expect-error timeZone must be a string when provided.
  defineSchedule({ cron: "0 9 * * *", handler: () => {}, timeZone: 1 })
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

it("types the Process Schedule Runtime", () => {
  expectTypeOf<ProcessScheduleRuntimeOptions>().toEqualTypeOf<{
    catchUpMs?: number
    concurrency?: number
    intervalMs?: number
    now?: () => Date
    onError?: (error: unknown) => void
    registry: ScheduleDefinitionRegistry
    scheduleRunStore: ScheduleRunStore
  }>()
  expectTypeOf(installProcessScheduleRuntime).parameter(0).toEqualTypeOf<ProcessScheduleRuntimeOptions>()
  expectTypeOf(installProcessScheduleRuntime).returns.toEqualTypeOf<Promise<ScheduleRuntimeController>>()
})

it("types generated Nitro Process Runtime options", () => {
  expectTypeOf<ScheduleProcessRuntimeOptions>().toEqualTypeOf<{
    catchUpMs?: number
    concurrency?: number
    driver: "process"
    intervalMs?: number
    prefix?: string
  }>()
  hubSchedule({ runtime: { catchUpMs: 0, concurrency: 2, driver: "process", intervalMs: 5_000, prefix: "app:schedule" } })

  // @ts-expect-error Generated Process Runtime does not serialize test clocks.
  hubSchedule({ runtime: { driver: "process", now: () => new Date() } })
})
