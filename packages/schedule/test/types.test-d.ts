import { expectTypeOf, it } from "vitest"

import { defineSchedule, defineScheduleTarget, schedules } from "../src/index.ts"
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
