// Nuxt auto-imports defineSchedule.
export default defineSchedule('0 3 * * *', async ({ scheduledAt }) => {
  console.info('nightly', scheduledAt.toISOString())
}, {
  manual: true,
  timeZone: 'Europe/Stockholm',
})
