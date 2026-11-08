import { defineCronHandler } from '#nuxt/cron'

export default defineCronHandler(() => '*/5 * * * * *', async () => {
  console.log('every five seconds')
})
