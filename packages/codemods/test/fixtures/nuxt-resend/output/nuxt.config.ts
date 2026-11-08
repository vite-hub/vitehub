import { env } from 'vite-hub/env'

export default defineNuxtConfig({
  modules: ['@nuxt/ui', 'vite-hub/nuxt'],
  nitro: { preset: 'cloudflare-module' },
  runtimeConfig: { resend: { apiKey: '' } },
  vitehub: {
    host: 'cloudflare',
    email: {
      driver: 'resend',
      options: { apiKey: env({ secret: true, source: env.source('NUXT_RESEND_API_KEY') }) },
    },
  },
})
