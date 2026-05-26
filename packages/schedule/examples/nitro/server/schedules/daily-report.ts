import { defineSchedule } from "@vitehub/schedule"

export default defineSchedule({
  cron: "0 8 * * *",
  handler: async ({ scheduledAt }) => {
    console.log(`Generating daily report for ${scheduledAt.toISOString()}`)
  },
})
