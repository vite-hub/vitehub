import { isSandboxError, sandboxError } from '../sandbox/errors'
import { getViteHubErrorShape } from '@vite-hub/runtime'
import { hasRuntimeType } from '@vite-hub/runtime/internal/runtime-type'
import { types as nodeTypes } from 'node:util'

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
  if (isErrorValue(error)) {
    const message = readErrorMessage(error)
    return sandboxError(message
      ? message
      : "Sandbox execution failed.", {
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

function isErrorValue(value: unknown): value is Error {
  if (value instanceof Error) return true
  try {
    return nodeTypes.isNativeError(value)
  }
  catch {
    return false
  }
}

function readErrorMessage(error: Error): string | undefined {
  try {
    const message = error.message
    return hasRuntimeType(message, 'string') && message.length > 0
      ? message
      : undefined
  }
  catch {
    return undefined
  }
}

function sandboxCode(code: string | undefined): `SANDBOX_${string}` {
  return code?.startsWith('SANDBOX_') ? code as `SANDBOX_${string}` : 'SANDBOX_RUNTIME_ERROR'
}
