import { isSandboxError, sandboxError } from '../sandbox/errors'
import { getViteHubErrorShape } from '@vite-hub/runtime'

export function readSandboxErrorMetadata(error: unknown) {
  if (!error || typeof error !== 'object')
    return undefined

  const metadata = error as {
    code?: unknown
    provider?: unknown
    cause?: unknown
    details?: unknown
  }

  const shape = getViteHubErrorShape(error)
  return {
    code: shape?.code || (typeof metadata.code === 'string' ? metadata.code : undefined),
    provider: typeof shape?.details?.provider === 'string'
      ? shape.details.provider
      : typeof metadata.provider === 'string' ? metadata.provider : undefined,
    cause: metadata.cause,
    details: shape?.details || (typeof metadata.details === 'object' && metadata.details !== null
      ? metadata.details as Record<string, unknown>
      : undefined),
  }
}

export function toSandboxError(error: unknown) {
  if (isSandboxError(error))
    return error

  const metadata = readSandboxErrorMetadata(error)
  if (error instanceof Error) {
    return sandboxError(error.message || "Sandbox execution failed.", {
      code: sandboxCode(metadata?.code),
      provider: metadata?.provider,
      details: metadata?.details,
      cause: metadata?.cause ?? error,
    })
  }

  return sandboxError(String(error) || "Sandbox execution failed.", {
    code: sandboxCode(metadata?.code),
    provider: metadata?.provider,
    details: metadata?.details,
    cause: metadata?.cause ?? error,
  })
}

function sandboxCode(code: string | undefined): `SANDBOX_${string}` {
  return code?.startsWith('SANDBOX_') ? code as `SANDBOX_${string}` : 'SANDBOX_RUNTIME_ERROR'
}
