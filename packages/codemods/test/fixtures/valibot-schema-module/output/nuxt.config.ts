import { env } from 'vite-hub/env'
import { publicApiBase } from './server/env.schema'

export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'node',
    env: {
      public: {
        apiBase: env({ default: 'https://api.example.com', mode: 'build', schema: publicApiBase, source: env.source('NUXT_PUBLIC_API_BASE') }),
      },
      server: {
        apiSecret: env({ schema: env.schemaFrom('./server/env.schema.ts', 'apiSecret'), secret: true, source: env.source('NUXT_API_SECRET') }),
        webhookSecret: env({ default: '', secret: true, source: env.source('NUXT_WEBHOOK_SECRET') }),
        allowedOrigins: env({ default: 'a,b', schema: env.schemaFrom('./server/env.schema.ts', 'allowedOrigins'), source: env.source('NUXT_ALLOWED_ORIGINS') }),
        port: env({ default: '3000', schema: env.schemaFrom('./server/env.schema.ts', 'port'), source: env.source('NUXT_PORT') }),
      },
    },
  },
})
