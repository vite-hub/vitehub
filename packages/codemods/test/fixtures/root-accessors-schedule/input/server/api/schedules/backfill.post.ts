import { defineEventHandler } from 'h3'
import registry from '#vitehub/schedule/registry'
import { runSchedule } from 'vite-hub/schedule/runtime'

export default defineEventHandler(async () => {
  const run = await runSchedule('daily-report', { registry, scheduledAt: '2026-01-31T23:59:00Z' })
  return { id: run.id, status: run.status }
})
