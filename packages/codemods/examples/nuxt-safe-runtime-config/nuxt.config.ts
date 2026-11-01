import * as v from 'valibot'

export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  modules: ['nuxt-safe-runtime-config'],
  runtimeConfig: {
    apiSecret: '',
    maxRetries: 3,
    featureEnabled: false,
    public: {
      apiBase: 'https://api.example.com',
    },
  },
  safeRuntimeConfig: {
    $schema: v.object({
      apiSecret: v.pipe(v.string(), v.minLength(1)),
      maxRetries: v.number(),
      featureEnabled: v.boolean(),
      public: v.object({
        apiBase: v.pipe(v.string(), v.url()),
      }),
    }),
    validateAtRuntime: true,
  },
})
