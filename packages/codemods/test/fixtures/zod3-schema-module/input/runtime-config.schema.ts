import { z } from 'zod/v3'

export default z.object({
  sessionPassword: z.string().min(32),
  timeoutMs: z.coerce.number().int(),
  region: z.enum(['eu', 'us']),
  cacheTtl: z.number().refine(value => value > 0),
  redirectUrl: z.string().transform(value => new URL(value)).optional(),
  public: z.object({
    siteName: z.string(),
    posthog: z.object({
      host: z.string().url(),
      sampleRate: z.number().min(0).max(1).nullable(),
    }),
  }),
})
