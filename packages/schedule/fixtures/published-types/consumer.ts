import { ViteHubError } from "@vite-hub/runtime"
import registry from "#vitehub/schedule/registry"

import type { ScheduleDefinitionRegistry, ScheduleErrorCode, ScheduleErrorDetails } from "@vite-hub/schedule"
import { defineSchedule } from "@vite-hub/schedule"
import { createKVScheduleRunStore, createMemoryScheduleRunStore, executeSchedule } from "@vite-hub/schedule/runtime"
import { scheduleKVStorage } from "@vite-hub/schedule/runtime/kv"
import { installProcessScheduleRuntime } from "@vite-hub/schedule/runtime/process"

createKVScheduleRunStore({ kvStore: scheduleKVStorage })
// @ts-expect-error KV storage must be selected explicitly.
createKVScheduleRunStore()
// @ts-expect-error A prefix does not select KV storage.
createKVScheduleRunStore({ prefix: "proof" })

// @ts-expect-error Discovery belongs to the build integration entry.
import { discoverScheduleDefinitions } from "@vite-hub/schedule"
// @ts-expect-error Execution and store helpers belong to the runtime entry.
import { executeSchedule as rootExecuteSchedule } from "@vite-hub/schedule"
import { schedules } from "@vite-hub/schedule/runtime"

void discoverScheduleDefinitions
void rootExecuteSchedule
void schedules

const controller = await installProcessScheduleRuntime({ registry, scheduleRunStore: createMemoryScheduleRunStore() })
await controller.close()

await executeSchedule({
  definition: defineSchedule({ cron: "0 9 * * *", handler: () => "ok" }),
  runStore: createMemoryScheduleRunStore(),
  scheduleId: "proof",
  scheduledAt: new Date("2026-01-01T09:00:00.000Z"),
  target: "proof",
})

registry satisfies ScheduleDefinitionRegistry

const code = "SCHEDULE_DEFINITION_NOT_FOUND" satisfies ScheduleErrorCode
const details = { field: "scheduledAt", valueType: "string" } satisfies ScheduleErrorDetails
const error = new ViteHubError(code, "Static Schedule Definition was not found.")
new ViteHubError("SCHEDULE_INVALID_SCHEDULED_AT", "Schedule scheduledAt value is invalid.", { details })

error.code satisfies ScheduleErrorCode

// @ts-expect-error Schedule fields use a closed vocabulary.
const invalidDetails: ScheduleErrorDetails = { field: "token", valueType: "string" }
void invalidDetails
