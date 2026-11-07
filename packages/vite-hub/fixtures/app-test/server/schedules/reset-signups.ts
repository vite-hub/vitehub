import { defineSchedule } from "vite-hub/schedule"
import { kv } from "vite-hub/kv"

export default defineSchedule({
  cron: "0 0 * * *",
  async handler({ scheduledAt }) {
    const [error] = await kv.set("signups:reset-at", scheduledAt.toISOString())
    if (error) throw error
    const [deleteError] = await kv.del("signups")
    if (deleteError) throw deleteError
  },
})
