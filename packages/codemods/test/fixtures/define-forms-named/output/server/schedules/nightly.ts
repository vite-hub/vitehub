// Nuxt auto-imports defineSchedule.
export default defineSchedule({ cron: '0 3 * * *', manual: true, timeZone: 'Europe/Stockholm', handler: async ({ scheduledAt }) => {
  console.info('nightly', scheduledAt.toISOString())
} })
