import { defineSchedule } from "@vitehub/schedule"
import { kv } from "@vitehub/kv"

export const scheduleMarkerKey = "schedule-e2e:daily-marker"

function resolveScheduleMarkerProvider() {
  return process.env.VITEHUB_HOSTING || (process.env.VERCEL ? "vercel" : "cloudflare")
}

export default defineSchedule("* * * * *", async ({ id, scheduledAt }) => {
  await kv.set(scheduleMarkerKey, {
    framework: "nitro",
    id,
    provider: resolveScheduleMarkerProvider(),
    ranAt: scheduledAt.toISOString(),
    schedule: "daily-marker",
  })
})
