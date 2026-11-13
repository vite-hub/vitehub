import { defineEventHandler } from 'h3'
import { runSchedule } from 'vite-hub/schedule'

export default defineEventHandler(async () => {
  const run = await runSchedule('daily-report', { scheduledAt: '2026-01-31T23:59:00Z' })
  return { id: run.id, status: run.status }
})
