import { H3, readBody } from "h3"

import { schedules } from "@vite-hub/schedule/runtime"

const app = new H3()

app.get("/api/schedules", async () => {
  return { schedules: await schedules.list() }
})

app.post("/api/schedules", async (event) => {
  const body = await readBody<{ cron?: string }>(event)
  const schedule = await schedules.create({
    cron: body.cron || "30 3 * * 1",
    target: "database-cleanup",
  })

  return { ok: true, schedule }
})

export default app
