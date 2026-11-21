import { defineEventHandler } from 'h3'
import { runSchedule } from 'vite-hub/schedule'

export default defineEventHandler(async () => {
  const [runError, run] = await runSchedule('daily-report')
  if (runError) throw runError
  return { id: run.id, status: run.status }
})
