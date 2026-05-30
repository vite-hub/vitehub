import { schedules } from "@vite-hub/schedule/runtime"

export default defineEventHandler(async () => {
  return { schedules: await schedules.list() }
})
