import { env } from 'vite-hub/env'

// Nuxt 3 layout: app code lives in the project root.
export default defineNuxtConfig({
  modules: ['@nuxt/eslint', 'vite-hub/nuxt'],
  nitro: {
    preset: 'vercel',
  },
  vitehub: {
    preset: 'vercel',
    env: {
      public: {
        siteName: env({ default: 'Acme', mode: 'build', source: env.source('NUXT_PUBLIC_SITE_NAME') }),
        posthogHost: env({ default: 'https://eu.posthog.com', mode: 'build', source: env.source('NUXT_PUBLIC_POSTHOG_HOST') }),
        posthogSampleRate: env.number({ default: 0.1, mode: 'build', required: false, source: env.source('NUXT_PUBLIC_POSTHOG_SAMPLE_RATE') }),
      },
      server: {
        sessionPassword: env({ secret: true, source: env.source('NUXT_SESSION_PASSWORD') }),
        timeoutMs: env.number({ default: 2500, source: env.source('NUXT_TIMEOUT_MS') }),
        region: env.enum(['eu', 'us'], { default: 'eu', source: env.source('NUXT_REGION') }),
        cacheTtl: env.number({ default: 60, source: env.source('NUXT_CACHE_TTL') }),
        webhook: {
          signingSecret: env({ secret: true, source: env.source('NUXT_WEBHOOK_SIGNING_SECRET') }),
        },
        redirectUrl: env({ required: false, source: env.source('NUXT_REDIRECT_URL') }),
      },
    },
  },
})
