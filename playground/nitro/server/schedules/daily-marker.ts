import { defineSchedule } from "@vitehub/schedule"
import { kv } from "@vitehub/kv"

export const scheduleMarkerKey = "schedule-e2e:daily-marker"

export default defineSchedule("* * * * *", async ({ id, scheduledAt }) => {
  await kv.set(scheduleMarkerKey, {
    id,
    ranAt: scheduledAt.toISOString(),
    schedule: "daily-marker",
  })
})
