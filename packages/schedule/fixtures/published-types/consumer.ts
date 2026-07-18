import { ScheduleError } from "@vite-hub/schedule"

import type { ScheduleDefinitionRegistry, ScheduleErrorCode } from "@vite-hub/schedule"
import registry from "#vitehub/schedule/registry"

registry satisfies ScheduleDefinitionRegistry

const code = "SCHEDULE_NOT_FOUND" satisfies ScheduleErrorCode
const error = new ScheduleError(code)
new ScheduleError("SCHEDULE_INVALID_ID", { details: { field: "id", valueType: "string" } })

// @ts-expect-error Schedule details use a closed field/valueType schema.
new ScheduleError(code, { details: { field: "id", token: "private", valueType: "string" } })

error.code satisfies ScheduleErrorCode
error.toJSON().code satisfies ScheduleErrorCode
