export const CLOUDFLARE_SANDBOX_RETRY_DELAYS_MS = [1000, 2000, 5000, 10000, 15000]

export const CLOUDFLARE_RETRIABLE_STARTUP_ERROR_RE = /container is starting|currently provisioning|retry in a moment|network connection lost|not listening in the tcp address|durable object reset|code was updated|aborterror|aborted|maximum number of running container instances exceeded|there is no container instance that can be provided to this durable object|cloudflare box [a-z][a-z0-9]* timed out after \d+ms/i

function isErrorLike(value: unknown): value is { message?: unknown, cause?: unknown } {
  if (!value || typeof value !== 'object')
    return false

  try {
    return Object.prototype.toString.call(value) === '[object Error]'
  }
  catch {
    return false
  }
}

export function collectCloudflareErrorMessages(error: unknown, ...extraMessages: string[]): string {
  const messages = isErrorLike(error)
    ? [
        typeof error.message === 'string' ? error.message : '',
        isErrorLike(error.cause) && typeof error.cause.message === 'string' ? error.cause.message : '',
      ]
    : [String(error)]

  return [...messages, ...extraMessages].filter(Boolean).join('\n')
}
