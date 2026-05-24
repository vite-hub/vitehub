import { kv } from "@vitehub/kv"
import { defineSchedule } from "@vitehub/schedule"

import { type ScheduleMarker, resolveScheduleMarkerProvider, scheduleMarkerKey } from "./schedule-marker"

declare global {
  var __vitehubScheduleMarker: ScheduleMarker | undefined
}

export default defineSchedule("* * * * *", async ({ id, scheduledAt }) => {
  const marker = {
    framework: "vite",
    id,
    provider: resolveScheduleMarkerProvider(),
    ranAt: scheduledAt.toISOString(),
    schedule: "daily-marker",
  } satisfies ScheduleMarker
  globalThis.__vitehubScheduleMarker = marker
  await kv.set(scheduleMarkerKey, marker)
})
