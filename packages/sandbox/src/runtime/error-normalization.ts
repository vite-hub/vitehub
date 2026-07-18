import { readSandboxErrorInternals, SandboxError } from '../sandbox/errors'

import type { SandboxErrorCode } from '../sandbox/errors'
import type { SandboxProvider } from '../sandbox/types/common'
import type { ViteHubErrorDetails } from '@vite-hub/runtime'

const sandboxErrorCodes = new Set<SandboxErrorCode>([
  'SANDBOX_EXEC_FAILED',
  'SANDBOX_HANDLER_ERROR',
  'SANDBOX_INVALID_ARGUMENT',
  'SANDBOX_NOT_FOUND',
  'SANDBOX_NOT_SUPPORTED',
  'SANDBOX_PROCESS_EXITED',
  'SANDBOX_PROVIDER_REQUIRED',
  'SANDBOX_RUNTIME_ERROR',
  'SANDBOX_RUNTIME_INVALID',
  'SANDBOX_SERIALIZATION_ERROR',
  'SANDBOX_TIMEOUT',
  'SANDBOX_TRANSPORT_ERROR',
  'SANDBOX_VALIDATION_ERROR',
])

const legacyCodes: Record<string, SandboxErrorCode> = {
  INVALID_ARGUMENT: 'SANDBOX_INVALID_ARGUMENT',
  NOT_SUPPORTED: 'SANDBOX_NOT_SUPPORTED',
  PROCESS_EXITED: 'SANDBOX_PROCESS_EXITED',
  SERIALIZATION_ERROR: 'SANDBOX_SERIALIZATION_ERROR',
  TIMEOUT: 'SANDBOX_TIMEOUT',
  VALIDATION_ERROR: 'SANDBOX_VALIDATION_ERROR',
  VERCEL_SANDBOX_EXEC_FAILED: 'SANDBOX_EXEC_FAILED',
  VERCEL_SANDBOX_EXEC_TIMEOUT: 'SANDBOX_TIMEOUT',
  VERCEL_SANDBOX_RUNTIME_INVALID: 'SANDBOX_RUNTIME_INVALID',
}

function readProvider(value: unknown): SandboxProvider | undefined {
  return value === 'cloudflare' || value === 'vercel' ? value : undefined
}

function readSandboxErrorCode(value: unknown): SandboxErrorCode {
  if (typeof value !== 'string') return 'SANDBOX_RUNTIME_ERROR'
  if (sandboxErrorCodes.has(value as SandboxErrorCode)) return value as SandboxErrorCode
  if (value.startsWith('NOT_SUPPORTED_')) return 'SANDBOX_NOT_SUPPORTED'
  return legacyCodes[value] ?? 'SANDBOX_RUNTIME_ERROR'
}

export function readSandboxErrorMetadata(error: unknown) {
  if (!error || typeof error !== 'object')
    return undefined

  if (error instanceof SandboxError) {
    const internals = readSandboxErrorInternals(error)
    return {
      cause: internals.cause,
      code: internals.code,
      details: internals.details,
      provider: readProvider(internals.details?.provider),
    }
  }

  const metadata = error as {
    code?: unknown
    provider?: unknown
    cause?: unknown
    details?: unknown
  }
  const details =
    typeof metadata.details === 'object' && metadata.details !== null
      ? (metadata.details as Record<string, unknown>)
      : undefined

  return {
    code: typeof metadata.code === 'string' ? metadata.code : undefined,
    provider: readProvider(metadata.provider) ?? readProvider(details?.provider),
    cause: metadata.cause,
    details,
  }
}

export function toSandboxError(error: unknown) {
  if (error instanceof SandboxError)
    return error

  const metadata = readSandboxErrorMetadata(error)
  return new SandboxError({
    cause: error,
    code: readSandboxErrorCode(metadata?.code),
    details: metadata?.details || metadata?.provider
      ? {
          ...metadata?.details,
          ...(metadata?.provider ? { provider: metadata.provider } : {}),
        } as ViteHubErrorDetails
      : undefined,
    message: error instanceof Error ? error.message : String(error),
  })
}
