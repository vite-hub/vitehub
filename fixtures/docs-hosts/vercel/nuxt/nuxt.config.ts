export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'vercel',
    blob: true,
    queue: true,
  },
})
