import { defineSchedule } from "@vite-hub/schedule"

export default defineSchedule({
  cron: "0 2 * * 0",
  manual: true,
  handler: async ({ id, scheduledAt }) => {
    console.log(`Running cleanup ${id} at ${scheduledAt.toISOString()}`)
  },
})
