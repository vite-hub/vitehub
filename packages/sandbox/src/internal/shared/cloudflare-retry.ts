import { SandboxError } from '../../sandbox/errors'

export const CLOUDFLARE_SANDBOX_RETRY_DELAYS_MS = [1000, 2000, 5000, 10000, 15000]

export const CLOUDFLARE_RETRIABLE_STARTUP_ERROR_RE = /container is starting|currently provisioning|retry in a moment|network connection lost|not listening in the tcp address|durable object reset|code was updated|aborterror|aborted|maximum number of running container instances exceeded|there is no container instance that can be provided to this durable object/i

export function collectCloudflareErrorMessages(error: unknown, ...extraMessages: string[]): string {
  const sandboxError = error instanceof SandboxError ? error : undefined
  return [
    error instanceof Error ? error.message : String(error),
    error instanceof Error && error.cause instanceof Error ? error.cause.message : '',
    sandboxError?.cause instanceof Error ? sandboxError.cause.message : '',
    ...extraMessages,
  ].filter(Boolean).join('\n')
}
