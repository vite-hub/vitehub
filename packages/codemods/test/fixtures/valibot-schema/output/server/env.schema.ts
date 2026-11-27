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

export const apiSecret = runtimeConfigSchema.entries.apiSecret
export const allowedOrigins = runtimeConfigSchema.entries.allowedOrigins
export const tags = runtimeConfigSchema.entries.tags
export const publicApiBase = runtimeConfigSchema.entries.public.entries.apiBase
