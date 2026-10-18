import { isSandboxTaskError, sandboxTaskError } from '../sandbox-task/errors'
import { getViteHubErrorShape } from '@vite-hub/runtime'
import { hasRuntimeType } from '@vite-hub/runtime/internal/runtime-type'
import { types as nodeTypes } from 'node:util'

export function readSandboxTaskErrorMetadata(error: unknown) {
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

export function toSandboxTaskError(error: unknown) {
  if (isSandboxTaskError(error))
    return error

  const metadata = readSandboxTaskErrorMetadata(error)
  if (isErrorValue(error)) {
    const message = readErrorMessage(error)
    return sandboxTaskError(message
      ? message
      : "Sandbox execution failed.", {
      code: sandboxTaskCode(metadata?.code),
      provider: metadata?.provider,
      details: metadata?.details,
      cause: metadata?.cause ?? error,
    })
  }

  return sandboxTaskError(String(error) || "Sandbox execution failed.", {
    code: sandboxTaskCode(metadata?.code),
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

function sandboxTaskCode(code: string | undefined): `SANDBOX_TASK_${string}` {
  return code?.startsWith('SANDBOX_TASK_') ? code as `SANDBOX_TASK_${string}` : 'SANDBOX_TASK_RUNTIME_ERROR'
}
