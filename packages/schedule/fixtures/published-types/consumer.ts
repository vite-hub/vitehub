import { ViteHubError } from "@vite-hub/runtime"
import registry from "#vitehub/schedule/registry"

import type { ScheduleDefinitionRegistry, ScheduleErrorCode, ScheduleErrorDetails } from "@vite-hub/schedule"
import { defineSchedule } from "@vite-hub/schedule"
import { createMemoryScheduleRunStore, executeSchedule } from "@vite-hub/schedule/runtime"

// @ts-expect-error Discovery belongs to the build integration entry.
import { discoverScheduleDefinitions } from "@vite-hub/schedule"
// @ts-expect-error Execution and store helpers belong to the runtime entry.
import { executeRuntimeSchedule } from "@vite-hub/schedule"

await executeSchedule({
  definition: defineSchedule({ cron: "0 9 * * *", handler: () => "ok" }),
  runStore: createMemoryScheduleRunStore(),
  scheduleId: "proof",
  scheduledAt: new Date("2026-01-01T09:00:00.000Z"),
  target: "proof",
})

registry satisfies ScheduleDefinitionRegistry

const code = "SCHEDULE_NOT_FOUND" satisfies ScheduleErrorCode
const details = { field: "id", valueType: "string" } satisfies ScheduleErrorDetails
const error = new ViteHubError(code, "Runtime Schedule was not found.")
new ViteHubError("SCHEDULE_INVALID_ID", "Runtime Schedule id is invalid.", { details })

error.code satisfies ScheduleErrorCode

// @ts-expect-error Schedule fields use a closed vocabulary.
const invalidDetails: ScheduleErrorDetails = { field: "token", valueType: "string" }
void invalidDetails
