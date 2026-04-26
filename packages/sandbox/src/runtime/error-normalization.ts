import { SandboxError } from '../sandbox/errors'

export function readSandboxErrorMetadata(error: unknown) {
  if (!error || typeof error !== 'object')
    return undefined

  const metadata = error as {
    code?: unknown
    provider?: unknown
    cause?: unknown
    details?: unknown
  }

  return {
    code: typeof metadata.code === 'string' ? metadata.code : undefined,
    provider: typeof metadata.provider === 'string' ? metadata.provider : undefined,
    cause: metadata.cause,
    details: typeof metadata.details === 'object' && metadata.details !== null
      ? metadata.details as Record<string, unknown>
      : undefined,
  }
}

export function toSandboxError(error: unknown) {
  if (error instanceof SandboxError)
    return error

  const metadata = readSandboxErrorMetadata(error)
  if (error instanceof Error) {
    return new SandboxError(error.message, {
      code: metadata?.code || 'SANDBOX_RUNTIME_ERROR',
      provider: metadata?.provider,
      details: metadata?.details,
      cause: metadata?.cause ?? error,
    })
  }

  return new SandboxError(String(error), {
    code: metadata?.code || 'SANDBOX_RUNTIME_ERROR',
    provider: metadata?.provider,
    details: metadata?.details,
    cause: metadata?.cause ?? error,
  })
}
