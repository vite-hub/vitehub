export default defineNuxtConfig({
  modules: ['nuxt-cron', 'vite-hub/nuxt'],
  vitehub: {
    host: 'cloudflare',
    schedule: true,
  },
})
