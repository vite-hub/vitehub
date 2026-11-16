import { defineSchedule } from "vite-hub/schedule"
import { kv } from "vite-hub/kv"

export default defineSchedule({
  cron: "0 0 * * *",
  async handler({ scheduledAt }) {
    const [error] = await kv.set("last-reset", scheduledAt.toISOString())
    if (error) throw error
    const [deleteError] = await kv.delete("signups")
    if (deleteError) throw deleteError
  },
})
