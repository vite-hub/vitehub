import { env } from 'vite-hub/env'
import { publicPosthogHost, publicPosthogSampleRate } from './server/env.schema'

// Nuxt 3 layout: app code lives in the project root.
export default defineNuxtConfig({
  modules: ['@nuxt/eslint', 'vite-hub/nuxt'],
  nitro: {
    preset: 'vercel',
  },
  vitehub: {
    host: 'vercel',
    env: {
      public: {
        siteName: env({ default: 'Acme', mode: 'build', source: env.source('NUXT_PUBLIC_SITE_NAME') }),
        posthogHost: env({ default: 'https://eu.posthog.com', mode: 'build', schema: publicPosthogHost, source: env.source('NUXT_PUBLIC_POSTHOG_HOST') }),
        posthogSampleRate: env.json(publicPosthogSampleRate, { default: 0.1, mode: 'build', source: env.source('NUXT_PUBLIC_POSTHOG_SAMPLE_RATE') }),
      },
      server: {
        sessionPassword: env({ schema: env.schemaFrom('./server/env.schema.ts', 'sessionPassword'), secret: true, source: env.source('NUXT_SESSION_PASSWORD') }),
        timeoutMs: env.json(env.schemaFrom('./server/env.schema.ts', 'timeoutMs'), { default: '2500', source: env.source('NUXT_TIMEOUT_MS') }),
        region: env.enum(['eu', 'us'], { default: 'eu', source: env.source('NUXT_REGION') }),
        cacheTtl: env.json(env.schemaFrom('./server/env.schema.ts', 'cacheTtl'), { default: 60, source: env.source('NUXT_CACHE_TTL') }),
        webhook: {
          signingSecret: env({ default: '', secret: true, source: env.source('NUXT_WEBHOOK_SIGNING_SECRET') }),
        },
        redirectUrl: env({ optional: true, schema: env.schemaFrom('./server/env.schema.ts', 'redirectUrl'), source: env.source('NUXT_REDIRECT_URL') }),
      },
    },
  },
})
