import { types } from 'node:util'

export const CLOUDFLARE_SANDBOX_RETRY_DELAYS_MS = [1000, 2000, 5000, 10000, 15000]

export const CLOUDFLARE_RETRIABLE_STARTUP_ERROR_RE = /container is starting|currently provisioning|retry in a moment|network connection lost|not listening in the tcp address|durable object reset|code was updated|aborterror|aborted|maximum number of running container instances exceeded|there is no container instance that can be provided to this durable object|cloudflare sandbox [a-z][a-z0-9]* timed out after \d+ms/i

function collectErrorMessages(error: unknown): string {
  try {
    if (types.isNativeError(error)) {
      const message = error.message
      const cause = error.cause
      return [message, types.isNativeError(cause) ? cause.message : ''].filter(Boolean).join('\n')
    }
  }
  catch {
    // Provider errors can have throwing accessors; use the unknown-value fallback.
  }

  try {
    return String(error)
  }
  catch {
    return ''
  }
}

export function collectCloudflareErrorMessages(error: unknown, ...extraMessages: string[]): string {
  return [collectErrorMessages(error), ...extraMessages].filter(Boolean).join('\n')
}
