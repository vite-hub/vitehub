export default defineNuxtConfig({
  modules: ['@nuxt/ui', 'nuxt-resend'],
  resend: {
    apiKey: process.env.NUXT_RESEND_API_KEY,
  },
  nitro: { preset: 'cloudflare-module' },
})
