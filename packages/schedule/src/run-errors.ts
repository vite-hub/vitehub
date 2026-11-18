import { defineErrors } from "@vite-hub/runtime"

import type { ErrorCatalog } from "@vite-hub/runtime"

// A type alias, not an interface, so it fits the index signature of `defineErrors()`.
type RunScheduleErrorCodes = {
  SCHEDULE_INVALID_SCHEDULED_AT: { fix: string, why: string }
  SCHEDULE_RUN_STORE_FAILED: { fix: string, why: string }
}

// Errors that `runSchedule()` returns as `[error, undefined]`. A Definition that does not exist or does not set
// `manual: true` throws instead, because the code must change.
export const runScheduleErrors: ErrorCatalog<RunScheduleErrorCodes> = /*#__PURE__*/ defineErrors({
  docs: "https://vitehub.dev/docs/schedule/diagnostics",
  codes: {
    SCHEDULE_INVALID_SCHEDULED_AT: {
      why: "`runSchedule()` got a `scheduledAt` that is not a valid date-time.",
      fix: "Pass a valid `Date`, or an ISO 8601 date-time with `Z` or an offset, such as `2026-01-31T23:59:00Z`. Leave it out to run as of now.",
    },
    SCHEDULE_RUN_STORE_FAILED: {
      why: "The store of Schedule Runs failed, so the run did not start or its record is incomplete. `error.cause` has the store error.",
      fix: "Check that the Schedule run store, KV on most hosts, is reachable from this server, then run the Schedule again.",
    },
  },
})

export type RunScheduleErrorCode = keyof RunScheduleErrorCodes
