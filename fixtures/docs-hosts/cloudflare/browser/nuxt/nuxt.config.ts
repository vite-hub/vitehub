export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'cloudflare',
    browser: true,
  },
})
