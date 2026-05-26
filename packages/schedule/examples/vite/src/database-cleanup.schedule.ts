import { defineSchedule } from "@vitehub/schedule"

export default defineSchedule({
  allowRuntimeSchedules: true,
  cron: "0 2 * * 0",
  handler: async ({ id, scheduledAt }) => {
    console.log(`Running cleanup ${id} at ${scheduledAt.toISOString()}`)
  },
})
