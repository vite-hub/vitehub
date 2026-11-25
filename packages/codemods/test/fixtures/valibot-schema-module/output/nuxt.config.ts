import { env } from 'vite-hub/env'

export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'node',
    env: {
      public: {
        apiBase: env({ default: 'https://api.example.com', mode: 'build', source: env.source('NUXT_PUBLIC_API_BASE') }),
      },
      server: {
        apiSecret: env({ secret: true, source: env.source('NUXT_API_SECRET') }),
        webhookSecret: env({ default: '', secret: true, source: env.source('NUXT_WEBHOOK_SECRET') }),
        allowedOrigins: env({ default: 'a,b', source: env.source('NUXT_ALLOWED_ORIGINS') }),
        port: env.number({ default: 3000, source: env.source('NUXT_PORT') }),
      },
    },
  },
})
