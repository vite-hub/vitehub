import { z } from 'zod'

export default z.object({
  sessionPassword: z.string().min(32),
  timeoutMs: z.coerce.number().int(),
  region: z.enum(['eu', 'us']),
  cacheTtl: z.number().refine(value => value > 0),
  webhook: z.object({
    signingSecret: z.string(),
  }),
  redirectUrl: z.string().transform(value => new URL(value)).optional(),
  mode: z.union([z.string(), z.number()]),
  public: z.object({
    siteName: z.string(),
    posthog: z.object({
      host: z.url(),
      sampleRate: z.number().min(0).max(1).nullable(),
    }),
  }),
}).refine(config => config.cacheTtl < 3600)
