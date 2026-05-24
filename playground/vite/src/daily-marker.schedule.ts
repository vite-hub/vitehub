import { kv } from "@vitehub/kv"
import { defineSchedule } from "@vitehub/schedule"

import { type ScheduleMarker, scheduleMarkerKey } from "./schedule-marker"

declare global {
  var __vitehubScheduleMarker: ScheduleMarker | undefined
}

export default defineSchedule("* * * * *", async ({ id, scheduledAt }) => {
  const marker = {
    id,
    ranAt: scheduledAt.toISOString(),
    schedule: "daily-marker",
  }
  globalThis.__vitehubScheduleMarker = marker
  await kv.set(scheduleMarkerKey, marker)
})
