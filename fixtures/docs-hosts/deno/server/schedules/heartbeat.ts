import { defineSchedule } from '@vite-hub/schedule'

export default defineSchedule({
  cron: '0 * * * *',
  handler: () => undefined,
})
