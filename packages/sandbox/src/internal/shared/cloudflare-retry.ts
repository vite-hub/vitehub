import { SandboxError } from '../../sandbox/errors'

export const CLOUDFLARE_RETRY_DELAYS_MS = [1000, 2000, 5000, 10000, 15000]
export const CLOUDFLARE_SANDBOX_RETRY_DELAYS_MS = CLOUDFLARE_RETRY_DELAYS_MS
export const CLOUDFLARE_RETRIABLE_STARTUP_ERROR_RE = /container is starting|currently provisioning|retry in a moment|network connection lost|not listening in the tcp address|durable object reset|code was updated|aborterror|aborted|maximum number of running container instances exceeded|there is no container instance that can be provided to this durable object/i

type CloudflareRetryMetadata = {
  code?: string
  provider?: string
  cause?: unknown
}

function readCloudflareRetryMetadata(error: unknown): CloudflareRetryMetadata | undefined {
  if (!error || typeof error !== 'object')
    return undefined

  const metadata = error as {
    code?: unknown
    provider?: unknown
    cause?: unknown
  }

  return {
    code: typeof metadata.code === 'string' ? metadata.code : undefined,
    provider: typeof metadata.provider === 'string' ? metadata.provider : undefined,
    cause: metadata.cause,
  }
}

function collectCloudflareRetryMessages(error: unknown): string {
  const sandboxError = error instanceof SandboxError ? error : undefined
  const metadata = readCloudflareRetryMetadata(error)

  return [
    error instanceof Error ? error.message : String(error),
    error instanceof Error && error.cause instanceof Error ? error.cause.message : '',
    sandboxError?.cause instanceof Error ? sandboxError.cause.message : '',
    metadata?.cause instanceof Error ? metadata.cause.message : '',
  ].filter(Boolean).join('\n')
}

export function isRetriableCloudflareError(
  error: unknown,
  options: {
    allowedCodes?: string[]
  } = {},
): boolean {
  const sandboxError = error instanceof SandboxError ? error : undefined
  const metadata = readCloudflareRetryMetadata(error)
  const provider = sandboxError?.provider || metadata?.provider

  if (provider && provider !== 'cloudflare')
    return false

  const allowedCodes = new Set(options.allowedCodes || ['TIMEOUT'])
  const code = sandboxError?.code || metadata?.code
  if (code && allowedCodes.has(code))
    return true

  return CLOUDFLARE_RETRIABLE_STARTUP_ERROR_RE.test(collectCloudflareRetryMessages(error))
}
