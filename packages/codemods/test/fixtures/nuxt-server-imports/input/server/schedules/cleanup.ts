import { kv } from "vite-hub/kv"
import { defineSchedule } from "vite-hub/schedule"

export default defineSchedule({
  cron: "0 0 * * *",
  async handler() {
    const [error] = await kv.clear({ prefix: "welcome:" })
    if (error) throw error
  },
})
