import { defineSchedule } from "vite-hub/schedule"

import { record } from "../oracle"

export default defineSchedule({
  cron: "* * * * *",
  async handler({ scheduledAt }) {
    await record("schedule", scheduledAt.toISOString())
  },
})
