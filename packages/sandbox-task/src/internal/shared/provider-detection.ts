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
  return !!(env.CLOUDFLARE_WORKER || env.CF_PAGES)
}
export const isVercel = () => { const env = getRuntimeEnv(); return !!(env.VERCEL || env.VERCEL_ENV) }
