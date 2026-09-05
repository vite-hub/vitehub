import { expectTypeOf, it } from "vitest"

import { defineSchedule, defineScheduleTarget, executeRuntimeSchedule, executeStaticSchedule, schedules } from "../src/index.ts"
import { installScheduleRuntime } from "../src/runtime/driver.ts"
import { createProcessScheduleWakeDriver } from "../src/runtime/process.ts"
import { hubSchedule } from "../src/vite.ts"
import "../src/runtime.ts"
import registry from "#vitehub/schedule/registry"
import type { InstallScheduleRuntimeOptions, RuntimeScheduleWake, RuntimeScheduleWakeDriver, RuntimeScheduleWakeDriverContext, RuntimeScheduleWakeDriverFactory, ScheduleRuntimeController } from "../src/runtime/driver.ts"
import type { ProcessScheduleWakeDriverOptions } from "../src/runtime/process.ts"
import type { ScheduleProcessRuntimeOptions } from "../src/vite.ts"
import type { RuntimeScheduleRecord, RuntimeScheduleStore, ScheduleDefinitionRegistry, ScheduleRunStore } from "../src/types.ts"

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
      expectTypeOf(context.waitUntil).toEqualTypeOf<(promise: PromiseLike<unknown>) => void>()
      context.waitUntil(Promise.resolve())
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

it("types host waitUntil for Static and Runtime Schedule execution", async () => {
  const waitUntil = (promise: PromiseLike<unknown>) => { void promise }

  await executeStaticSchedule({
    cron: "0 9 * * *",
    definition: defineSchedule({ cron: "0 9 * * *", handler: async () => {} }),
    name: "daily-report",
    waitUntil,
  })
  await executeRuntimeSchedule({ id: "daily-report", waitUntil })
})

it("types Runtime Schedule helper inputs", async () => {
  const created = await schedules.create({ cron: "0 9 * * *", input: { prompt: "Daily report" }, target: "daily-report", timeZone: "Europe/Copenhagen" })
  expectTypeOf(created.input).toEqualTypeOf<{ prompt: string } | undefined>()
  const updated = await schedules.update("schedule-1", { cron: "15 10 * * *", enabled: false, input: { prompt: "Weekday report" }, target: "daily-report", timeZone: "Asia/Bangkok" })
  expectTypeOf(updated.input).toEqualTypeOf<unknown>()

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

it("types the Runtime Schedule Wake Driver boundary", () => {
  expectTypeOf<RuntimeScheduleWake>().toEqualTypeOf<{
    scheduleId: string
    scheduledAt: Date
  }>()
  expectTypeOf<RuntimeScheduleWakeDriverContext>().toEqualTypeOf<{
    reportError: (error: unknown) => void
    wake: (input: RuntimeScheduleWake) => Promise<void>
  }>()
  expectTypeOf<RuntimeScheduleWakeDriver>().toEqualTypeOf<{
    close?: () => Promise<void> | void
    reconcile: (schedules: readonly RuntimeScheduleRecord[]) => Promise<void>
  }>()
  expectTypeOf<RuntimeScheduleWakeDriverFactory>().returns.toEqualTypeOf<RuntimeScheduleWakeDriver | Promise<RuntimeScheduleWakeDriver>>()
  expectTypeOf<InstallScheduleRuntimeOptions>().toEqualTypeOf<{
    createDriver: RuntimeScheduleWakeDriverFactory
    onError?: (error: unknown) => void
    registry: ScheduleDefinitionRegistry
    runtimeScheduleStore: RuntimeScheduleStore
    scheduleRunStore: ScheduleRunStore
    staticRegistry?: ScheduleDefinitionRegistry
  }>()
  expectTypeOf(installScheduleRuntime).parameter(0).toEqualTypeOf<InstallScheduleRuntimeOptions>()
  expectTypeOf(installScheduleRuntime).returns.toEqualTypeOf<Promise<ScheduleRuntimeController>>()
})

it("types the built-in Process Schedule Wake Driver", () => {
  expectTypeOf<ProcessScheduleWakeDriverOptions>().toEqualTypeOf<{
    concurrency?: number
    intervalMs?: number
    now?: () => Date
  }>()
  expectTypeOf(createProcessScheduleWakeDriver).parameter(0).toEqualTypeOf<ProcessScheduleWakeDriverOptions | undefined>()
  expectTypeOf(createProcessScheduleWakeDriver).returns.toEqualTypeOf<RuntimeScheduleWakeDriverFactory>()
})

it("types generated Nitro Process Runtime options", () => {
  expectTypeOf<ScheduleProcessRuntimeOptions>().toEqualTypeOf<{
    concurrency?: number
    driver: "process"
    intervalMs?: number
    prefix?: string
  }>()
  hubSchedule({ runtime: { concurrency: 2, driver: "process", intervalMs: 5_000, prefix: "app:schedule" } })

  // @ts-expect-error Generated Process Runtime does not serialize test clocks.
  hubSchedule({ runtime: { driver: "process", now: () => new Date() } })
})

const dailyReport = defineScheduleTarget<{ prompt: string }>({ handler: context => context.input?.prompt })
const countReport = defineScheduleTarget<{ count: number }>({ handler: context => context.input?.count })

declare module "../src/types.ts" {
  interface ScheduleTargetRegistry {
    "daily-report": typeof dailyReport
    "count-report": typeof countReport
  }
}

it("checks input against the selected Schedule target", async () => {
  // @ts-expect-error Input belongs to count-report.
  await schedules.create({ target: "daily-report", cron: "0 9 * * *", input: { count: 1 } })
  // @ts-expect-error Unknown target.
  await schedules.create({ target: "missing", cron: "0 9 * * *" })
  // @ts-expect-error An existing record ID does not prove its input type.
  await schedules.update("stored-id", { input: { prompt: "hello" } })
  // @ts-expect-error Update inputs also belong to the selected target.
  await schedules.update("stored-id", { target: "daily-report", input: { count: 1 } })
  // @ts-expect-error Changing targets must replace or clear the old target input.
  await schedules.update("stored-id", { target: "daily-report" })
  await schedules.update("stored-id", { target: "daily-report", input: undefined })
  await schedules.update("stored-id", { enabled: false })
  await schedules.update("stored-id", { target: "daily-report", input: { prompt: "hello" } })
  const selected: "daily-report" | "count-report" = Math.random() > 0.5 ? "daily-report" : "count-report"
  // @ts-expect-error A union target cannot accept input valid for only one possible definition.
  await schedules.create({ target: selected, cron: "0 9 * * *", input: { prompt: "hello" } })
  const target: string = "external-target"
  // @ts-expect-error Dynamic target names use the operational API.
  await schedules.create({ target, cron: "0 9 * * *", input: { anything: true } })
  await schedules.dynamic.create({ target, cron: "0 9 * * *", input: { anything: true } })
})
