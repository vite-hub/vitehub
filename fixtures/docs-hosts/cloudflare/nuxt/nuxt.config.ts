export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'cloudflare',
    database: true,
    queue: true,
  },
})
