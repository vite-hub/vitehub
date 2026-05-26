import { defineSchedule } from "@vitehub/schedule"

export default defineSchedule("0 8 * * *", async ({ scheduledAt }) => {
  console.log(`Generating daily report for ${scheduledAt.toISOString()}`)
})
