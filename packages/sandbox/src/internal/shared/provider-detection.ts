export interface ProviderDetectionRule<TProvider extends string> {
  provider: TProvider
  when: () => boolean
}

export function createProviderDetector<TProvider extends string>(
  rules: ProviderDetectionRule<TProvider>[],
): () => TProvider | undefined {
  return () => {
    for (const rule of rules) {
      if (rule.when()) return rule.provider
    }
    return undefined
  }
}

function getRuntimeEnv(): Record<string, string | undefined> {
  return (typeof process !== 'undefined' ? process.env : {}) as Record<string, string | undefined>
}

export const isCloudflare = () => {
  const env = getRuntimeEnv()
  return !!(env.CLOUDFLARE_WORKER || env.CF_PAGES || typeof process === 'undefined')
}
export const isVercel = () => { const env = getRuntimeEnv(); return !!(env.VERCEL || env.VERCEL_ENV) }
export const isNetlify = () => { const env = getRuntimeEnv(); return !!(env.NETLIFY || env.NETLIFY_LOCAL) }
export const isNode = () => typeof process !== 'undefined'

export function getCloudflareEnv(event?: unknown): Record<string, unknown> | null {
  const context = (typeof event === 'object' && event
    ? (event as {
        req?: {
          runtime?: {
            cloudflare?: { env?: Record<string, unknown> }
          }
        }
        context?: {
          cloudflare?: { env?: Record<string, unknown> }
          _platform?: { cloudflare?: { env?: Record<string, unknown> } }
        }
      })
    : undefined)
  const globalEnv = (globalThis as { __env__?: Record<string, unknown> }).__env__
  const env = context?.req?.runtime?.cloudflare?.env
    || context?.context?.cloudflare?.env
    || context?.context?._platform?.cloudflare?.env
    || globalEnv
  return env && typeof env === 'object' ? env : null
}
