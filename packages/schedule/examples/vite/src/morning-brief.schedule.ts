import { defineSchedule } from "@vite-hub/schedule"

export default defineSchedule({
  cron: "0 8 * * 1-5",
  timeZone: "Europe/Madrid",
  handler: async ({ idempotencyKey, scheduledAt }) => {
    console.log(`Sending the morning brief for ${scheduledAt.toISOString()} (${idempotencyKey})`)
  },
})
