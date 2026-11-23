import { defineErrors } from "@vite-hub/runtime"

import type { ErrorCatalog } from "@vite-hub/runtime"

type StartedScheduleErrorCodes = {
  SCHEDULE_INVALID_OPTIONS: { fix: string, why: (data: { problem: string }) => string }
  SCHEDULE_NOT_FOUND: { fix: string, why: (data: { id: string }) => string }
  SCHEDULE_NOT_STARTABLE: { fix: string, why: (data: { name: string }) => string }
  SCHEDULE_STORE_FAILED: { fix: string, why: string }
  SCHEDULE_STORE_MISSING: { fix: string, why: string }
}

export const startedScheduleErrors: ErrorCatalog<StartedScheduleErrorCodes> = /*#__PURE__*/ defineErrors({
  docs: "https://vitehub.dev/docs/schedule/diagnostics",
  codes: {
    SCHEDULE_NOT_STARTABLE: {
      why: ({ name }: { name: string }) => `No Schedule Definition without \`cron\` is named "${name}", so \`startSchedule()\` cannot start it.`,
      fix: "Add `server/schedules/<name>.ts` with `export default defineSchedule({ handler })` and no `cron`. A Definition with its own `cron` runs only on that cron.",
    },
    SCHEDULE_INVALID_OPTIONS: {
      why: ({ problem }: { problem: string }) => `\`startSchedule()\` options are invalid: ${problem}`,
      fix: "Pass `{ at }` for one run, or `{ cron, timeZone }` for a repeating Schedule, and a JSON `payload`.",
    },
    SCHEDULE_NOT_FOUND: {
      why: ({ id }: { id: string }) => `No started Schedule has the id "${id}". It ran its last time, was cancelled, or never existed.`,
      fix: "List the started Schedules with `listSchedules()` or `vitehub schedule list`.",
    },
    SCHEDULE_STORE_MISSING: {
      why: "This server has no store for started Schedules.",
      fix: "Add a Schedule Definition without `cron` in `server/schedules/`, enable `kv`, and build with Nitro. On Node, also set `schedule: { runtime: { driver: \"process\" } }`.",
    },
    SCHEDULE_STORE_FAILED: {
      why: "The store of started Schedules failed. `error.cause` has the store error.",
      fix: "Check that KV is enabled and reachable from this server, then try again.",
    },
  },
})

export type StartedScheduleErrorCode = keyof StartedScheduleErrorCodes
