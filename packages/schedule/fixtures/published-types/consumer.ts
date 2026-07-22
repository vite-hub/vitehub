import { ViteHubError } from "@vite-hub/runtime"
import registry from "#vitehub/schedule/registry"

import type { ScheduleDefinitionRegistry, ScheduleErrorCode, ScheduleErrorDetails } from "@vite-hub/schedule"

registry satisfies ScheduleDefinitionRegistry

const code = "SCHEDULE_NOT_FOUND" satisfies ScheduleErrorCode
const details = { field: "id", valueType: "string" } satisfies ScheduleErrorDetails
const error = new ViteHubError(code, "Runtime Schedule was not found.")
new ViteHubError("SCHEDULE_INVALID_ID", "Runtime Schedule id is invalid.", { details })

error.code satisfies ScheduleErrorCode

// @ts-expect-error Schedule fields use a closed vocabulary.
const invalidDetails: ScheduleErrorDetails = { field: "token", valueType: "string" }
void invalidDetails
