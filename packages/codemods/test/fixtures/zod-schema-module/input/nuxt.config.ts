// Nuxt 3 layout: app code lives in the project root.
export default defineNuxtConfig({
  modules: ['@nuxt/eslint', 'nuxt-safe-runtime-config'],
  nitro: {
    preset: 'vercel',
  },
  runtimeConfig: {
    sessionPassword: 'dev-only-password',
    timeoutMs: '2500',
    region: 'eu',
    cacheTtl: 60,
    webhook: { signingSecret: '' },
    public: {
      siteName: 'Acme',
      posthog: { host: 'https://eu.posthog.com', sampleRate: 0.1 },
    },
  },
  safeRuntimeConfig: {
    $schema: './runtime-config.schema',
  },
})
