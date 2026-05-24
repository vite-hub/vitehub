import { defineSchedule } from "@vitehub/schedule"

export const scheduleMarkerKey = "schedule-e2e:daily-marker"

type ScheduleMarker = {
  id: string
  ranAt: string
  schedule: "daily-marker"
}

declare global {
  var __vitehubScheduleMarker: ScheduleMarker | undefined
}

export default defineSchedule("* * * * *", async ({ id, scheduledAt }) => {
  globalThis.__vitehubScheduleMarker = {
    id,
    ranAt: scheduledAt.toISOString(),
    schedule: "daily-marker",
  }
})
