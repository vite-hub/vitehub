export default defineNuxtConfig({
  modules: ['nuxt-safe-runtime-config'],
  runtimeConfig: {
    sessionPassword: 'dev-only-password',
    timeoutMs: '2500',
    region: 'eu',
    cacheTtl: 60,
    public: {
      siteName: 'Acme',
      posthog: { host: 'https://eu.posthog.com', sampleRate: 0.1 },
    },
  },
  safeRuntimeConfig: {
    $schema: './runtime-config.schema',
  },
})
