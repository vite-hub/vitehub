import * as v from 'valibot'

const runtimeConfigSchema = v.object({
  apiSecret: v.pipe(v.string(), v.minLength(16)),
  databaseUrl: v.string(),
  maxRetries: v.number(),
  featureEnabled: v.boolean(),
  logLevel: v.optional(v.picklist(['debug', 'info', 'warn'])),
  allowedOrigins: v.pipe(v.string(), v.transform(value => value.split(','))),
  tags: v.array(v.string()),
  stripe: v.object({
    secretKey: v.string(),
    accountId: v.string(),
  }),
  public: v.object({
    apiBase: v.pipe(v.string(), v.url()),
    sampleRate: v.optional(v.number()),
  }),
})

export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  modules: ['nuxt-safe-runtime-config'],
  runtimeConfig: {
    apiSecret: '',
    databaseUrl: process.env.DATABASE_URL,
    maxRetries: 3,
    featureEnabled: false,
    logLevel: 'info',
    allowedOrigins: 'https://example.com',
    tags: ['a'],
    stripe: {
      secretKey: '',
      accountId: 'acct_123',
    },
    untouched: 'keep me',
    public: {
      apiBase: 'https://api.example.com',
      sampleRate: 0.5,
    },
  },
  safeRuntimeConfig: {
    $schema: runtimeConfigSchema,
    validateAtRuntime: true,
  },
})
