import { schedules } from "@vitehub/schedule/runtime"

export default defineEventHandler(async () => {
  return { schedules: await schedules.list() }
})
