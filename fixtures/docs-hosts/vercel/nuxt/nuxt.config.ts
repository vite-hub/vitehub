export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    preset: 'vercel',
    blob: true,
    queue: true,
  },
})
