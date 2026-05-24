import { defineSchedule } from "@vitehub/schedule"

export default defineSchedule(
  "0 2 * * 0",
  async ({ id, scheduledAt }) => {
    console.log(`Running cleanup ${id} at ${scheduledAt.toISOString()}`)
  },
  {
    allowRuntimeSchedules: true,
    id: "database-cleanup",
  },
)
