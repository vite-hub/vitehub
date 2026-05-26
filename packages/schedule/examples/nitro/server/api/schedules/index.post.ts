import { schedules } from "@vitehub/schedule/runtime"

export default defineEventHandler(async (event) => {
  const body = await readBody<{ cron?: string }>(event)
  const schedule = await schedules.create({
    cron: body.cron || "30 3 * * 1",
    target: "database-cleanup",
  })

  return { ok: true, schedule }
})
