export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    preset: 'cloudflare',
    cloudflare: { secretsFile: '.env' },
  },
})
