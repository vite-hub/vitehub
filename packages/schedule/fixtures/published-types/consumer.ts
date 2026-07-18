import { ScheduleError } from "@vite-hub/schedule"

import type { ScheduleDefinitionRegistry, ScheduleErrorCode } from "@vite-hub/schedule"
import registry from "#vitehub/schedule/registry"

registry satisfies ScheduleDefinitionRegistry

const code = "SCHEDULE_NOT_FOUND" satisfies ScheduleErrorCode
const error = new ScheduleError("Runtime Schedule not found: daily", {
  code,
  details: { id: "daily" },
  httpStatus: 404,
})

error.code satisfies ScheduleErrorCode
error.toJSON().code satisfies ScheduleErrorCode
