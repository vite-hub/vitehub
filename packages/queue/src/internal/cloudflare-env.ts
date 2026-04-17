export function getCloudflareEnv(event: unknown): Record<string, unknown> | undefined {
  const target = event as {
    context?: {
      cloudflare?: { env?: Record<string, unknown> }
      _platform?: { cloudflare?: { env?: Record<string, unknown> } }
    }
    env?: Record<string, unknown>
    req?: {
      context?: { cloudflare?: { env?: Record<string, unknown> } }
      runtime?: { cloudflare?: { env?: Record<string, unknown> } }
    }
    runtime?: { cloudflare?: { env?: Record<string, unknown> } }
  } | undefined

  return target?.env
    || target?.runtime?.cloudflare?.env
    || target?.req?.runtime?.cloudflare?.env
    || target?.req?.context?.cloudflare?.env
    || target?.context?.cloudflare?.env
    || target?.context?._platform?.cloudflare?.env
    || (globalThis as { __env__?: Record<string, unknown> }).__env__
}
