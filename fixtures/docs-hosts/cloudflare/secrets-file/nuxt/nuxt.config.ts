export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'cloudflare',
    cloudflare: { secretsFile: '.env' },
  },
})
