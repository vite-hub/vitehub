import { defineEventHandler } from 'h3'
import { runSchedule } from '@vite-hub/schedule'

export default defineEventHandler(async () => {
  const run = await runSchedule('daily-report')
  return { id: run.id, status: run.status }
})
