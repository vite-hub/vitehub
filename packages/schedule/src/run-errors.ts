import { defineErrors } from "@vite-hub/runtime"

import type { ErrorCatalog } from "@vite-hub/runtime"

type RunScheduleErrorCodes = {
  SCHEDULE_INVALID_SCHEDULED_AT: { fix: string, why: string }
  SCHEDULE_RUN_STORE_FAILED: { fix: string, why: string }
}

export const runScheduleErrors: ErrorCatalog<RunScheduleErrorCodes> = /*#__PURE__*/ defineErrors({
  docs: "https://vitehub.dev/docs/schedule/diagnostics",
  codes: {
    SCHEDULE_INVALID_SCHEDULED_AT: {
      why: "`runSchedule()` got a `scheduledAt` that is not a valid date-time.",
      fix: "Pass a valid `Date`, or an ISO 8601 date-time with `Z` or an offset, such as `2026-01-31T23:59:00Z`. Leave it out to run as of now.",
    },
    SCHEDULE_RUN_STORE_FAILED: {
      why: "The store of Schedule Runs failed, so the run did not start or its record is incomplete. `error.cause` has the store error.",
      fix: "Check that the Schedule run store is reachable from this server. Before retrying, confirm that the handler did not already run or that it is safe to repeat.",
    },
  },
})

export type RunScheduleErrorCode = keyof RunScheduleErrorCodes
