import { env } from 'vite-hub/env'

export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  modules: ['vite-hub/nuxt'],
  runtimeConfig: {
    tags: ['a'],
    untouched: 'keep me',
  },
  vitehub: {
    preset: 'node',
    env: {
      public: {
        apiBase: env({ default: 'https://api.example.com', mode: 'build', source: env.source('NUXT_PUBLIC_API_BASE') }),
        sampleRate: env.number({ default: 0.5, mode: 'build', required: false, source: env.source('NUXT_PUBLIC_SAMPLE_RATE') }),
      },
      server: {
        apiSecret: env({ secret: true, source: env.source('NUXT_API_SECRET') }),
        databaseUrl: env({ secret: true, source: env.source(['NUXT_DATABASE_URL', 'DATABASE_URL']) }),
        maxRetries: env.number({ default: 3, source: env.source('NUXT_MAX_RETRIES') }),
        featureEnabled: env.boolean({ default: false, source: env.source('NUXT_FEATURE_ENABLED') }),
        logLevel: env.enum(['debug', 'info', 'warn'], { default: 'info', required: false, source: env.source('NUXT_LOG_LEVEL') }),
        allowedOrigins: env({ default: 'https://example.com', source: env.source('NUXT_ALLOWED_ORIGINS') }),
        stripe: {
          secretKey: env({ secret: true, source: env.source('NUXT_STRIPE_SECRET_KEY') }),
          accountId: env({ default: 'acct_123', source: env.source('NUXT_STRIPE_ACCOUNT_ID') }),
        },
      },
    },
  },
})
