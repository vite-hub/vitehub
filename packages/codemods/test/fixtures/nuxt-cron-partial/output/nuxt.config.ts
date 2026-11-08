export default defineNuxtConfig({
  modules: ['nuxt-cron', 'vite-hub/nuxt'],
  vitehub: {
    preset: 'cloudflare',
    schedule: true,
  },
})
