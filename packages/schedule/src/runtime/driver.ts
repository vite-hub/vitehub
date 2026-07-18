import { installScheduleDriverRuntime } from "../internal/driver-runtime.ts"

import type { RuntimeScheduleRecord, RuntimeScheduleStore, RuntimeScheduleWake, ScheduleDefinitionRegistry, ScheduleRunStore } from "../types.ts"

export type { RuntimeScheduleWake } from "../types.ts"

export interface RuntimeScheduleWakeDriverContext {
  reportError(error: unknown): void
  wake(input: RuntimeScheduleWake): Promise<void>
}

export interface RuntimeScheduleWakeDriver {
  close?(): Promise<void> | void
  reconcile(schedules: readonly RuntimeScheduleRecord[]): Promise<void>
}

export type RuntimeScheduleWakeDriverFactory = (context: RuntimeScheduleWakeDriverContext) => Promise<RuntimeScheduleWakeDriver> | RuntimeScheduleWakeDriver

export interface InstallScheduleRuntimeOptions {
  createDriver: RuntimeScheduleWakeDriverFactory
  onError?: (error: unknown) => void
  registry: ScheduleDefinitionRegistry
  runtimeScheduleStore: RuntimeScheduleStore
  scheduleRunStore: ScheduleRunStore
  staticRegistry?: ScheduleDefinitionRegistry
}

export interface ScheduleRuntimeController {
  close(): Promise<void>
}

export async function installScheduleRuntime(options: InstallScheduleRuntimeOptions): Promise<ScheduleRuntimeController> {
  return installScheduleDriverRuntime(options)
}
