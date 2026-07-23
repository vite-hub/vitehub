import { kv } from "@vite-hub/kv"
import { defineSchedule } from "@vite-hub/schedule"

import { type ScheduleMarker, resolveScheduleMarkerProvider, scheduleMarkerKey } from "./schedule-marker"

declare global {
  var __vitehubScheduleMarker: ScheduleMarker | undefined
}

export default defineSchedule({
  cron: "* * * * *",
  handler: async ({ id, scheduledAt }) => {
    const marker = {
      id,
      provider: resolveScheduleMarkerProvider(),
      ranAt: scheduledAt.toISOString(),
      schedule: "daily-marker",
    } satisfies ScheduleMarker
    globalThis.__vitehubScheduleMarker = marker
    const [error] = await kv.set(scheduleMarkerKey, marker)
    if (error) throw error
  },
})
