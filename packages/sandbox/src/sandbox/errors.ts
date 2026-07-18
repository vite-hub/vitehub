import { ViteHubError } from '@vite-hub/runtime'

import type { ViteHubErrorDetails, ViteHubErrorShape } from '@vite-hub/runtime'
import type { SandboxProvider } from './types/common'

export type SandboxErrorCode
  = | 'SANDBOX_EXEC_FAILED'
    | 'SANDBOX_HANDLER_ERROR'
    | 'SANDBOX_INVALID_ARGUMENT'
    | 'SANDBOX_NOT_FOUND'
    | 'SANDBOX_NOT_SUPPORTED'
    | 'SANDBOX_PROCESS_EXITED'
    | 'SANDBOX_PROVIDER_REQUIRED'
    | 'SANDBOX_RUNTIME_ERROR'
    | 'SANDBOX_RUNTIME_INVALID'
    | 'SANDBOX_SERIALIZATION_ERROR'
    | 'SANDBOX_TIMEOUT'
    | 'SANDBOX_TRANSPORT_ERROR'
    | 'SANDBOX_VALIDATION_ERROR'

export type SandboxOperation = 'destroy' | 'exec' | 'mkdir' | 'readFile' | 'writeFile'

export interface SandboxErrorDetails extends ViteHubErrorDetails {
  operation?: SandboxOperation
  provider?: SandboxProvider
  status?: number
  timeoutMs?: number
}

export type SandboxErrorJSON = ViteHubErrorShape<SandboxErrorCode> & { details?: SandboxErrorDetails }

export interface SandboxErrorMetadata {
  cause?: unknown
  code?: unknown
  details?: Record<string, unknown>
  httpStatus?: unknown
  method?: unknown
  provider?: unknown
}

export interface SandboxErrorInternals extends SandboxErrorMetadata {
  code: SandboxErrorCode
  message: string
}

const internalsByError = new WeakMap<SandboxError, SandboxErrorInternals>()
const operations = new Set<SandboxOperation>(['destroy', 'exec', 'mkdir', 'readFile', 'writeFile'])

const codeAliases: Record<string, SandboxErrorCode> = {
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

const messages: Record<SandboxErrorCode, string> = {
  SANDBOX_EXEC_FAILED: 'Sandbox provider execution failed.',
  SANDBOX_HANDLER_ERROR: 'Sandbox definition execution failed.',
  SANDBOX_INVALID_ARGUMENT: 'Sandbox request is invalid.',
  SANDBOX_NOT_FOUND: 'Sandbox definition was not found.',
  SANDBOX_NOT_SUPPORTED: 'Sandbox operation is not supported by the selected provider.',
  SANDBOX_PROCESS_EXITED: 'Sandbox process exited before the requested condition was met.',
  SANDBOX_PROVIDER_REQUIRED: 'Sandbox provider could not be inferred. Configure `sandbox.provider` as `cloudflare` or `vercel`.',
  SANDBOX_RUNTIME_ERROR: 'Sandbox execution failed.',
  SANDBOX_RUNTIME_INVALID: 'Sandbox provider runtime is invalid.',
  SANDBOX_SERIALIZATION_ERROR: 'Sandbox input or output must be JSON-serializable.',
  SANDBOX_TIMEOUT: 'Sandbox operation timed out.',
  SANDBOX_TRANSPORT_ERROR: 'Sandbox provider request failed.',
  SANDBOX_VALIDATION_ERROR: 'Sandbox input is invalid.',
}

function normalizeCode(value: unknown): SandboxErrorCode {
  if (typeof value !== 'string')
    return 'SANDBOX_RUNTIME_ERROR'
  if (value.startsWith('NOT_SUPPORTED_'))
    return 'SANDBOX_NOT_SUPPORTED'
  if (value in messages)
    return value as SandboxErrorCode
  return codeAliases[value] ?? 'SANDBOX_RUNTIME_ERROR'
}

function safeDetails(metadata: SandboxErrorMetadata): SandboxErrorDetails | undefined {
  const operationValue = metadata.method ?? metadata.details?.operation
  const operation = typeof operationValue === 'string' && operations.has(operationValue as SandboxOperation) ? operationValue as SandboxOperation : undefined
  const provider = metadata.provider === 'cloudflare' || metadata.provider === 'vercel' ? metadata.provider : undefined
  const statusValue = metadata.httpStatus ?? metadata.details?.status
  const status = typeof statusValue === 'number' && Number.isInteger(statusValue) && statusValue >= 100 && statusValue <= 599 ? statusValue : undefined
  const timeoutValue = metadata.details?.timeoutMs ?? metadata.details?.timeout
  const timeoutMs = typeof timeoutValue === 'number' && Number.isFinite(timeoutValue) && timeoutValue > 0 ? timeoutValue : undefined

  if (!operation && !provider && !status && !timeoutMs)
    return undefined
  return { ...(operation ? { operation } : {}), ...(provider ? { provider } : {}), ...(status ? { status } : {}), ...(timeoutMs ? { timeoutMs } : {}) }
}

function publicMessage(code: SandboxErrorCode, details?: SandboxErrorDetails) {
  return code === 'SANDBOX_TIMEOUT' && details?.timeoutMs ? `Sandbox operation timed out after ${details.timeoutMs}ms.` : messages[code]
}

export class SandboxError extends ViteHubError<SandboxErrorCode> {
  declare readonly details?: SandboxErrorDetails
  readonly provider?: SandboxProvider

  constructor(message: string, metadata: string | SandboxErrorMetadata = {}) {
    const raw = typeof metadata === 'string' ? { code: metadata } : metadata
    const code = normalizeCode(raw.code)
    const details = safeDetails(raw)
    super(code, publicMessage(code, details), { cause: raw.cause, details: details as ViteHubErrorDetails | undefined })
    this.name = 'SandboxError'
    this.provider = details?.provider
    internalsByError.set(this, { ...raw, code, message })
  }

  override toJSON(): SandboxErrorJSON {
    return super.toJSON() as SandboxErrorJSON
  }
}

export function readSandboxErrorInternals(error: SandboxError): SandboxErrorInternals {
  return internalsByError.get(error) ?? { code: error.code, message: error.message }
}

export class NotSupportedError extends SandboxError {
  constructor(operation: string, provider: SandboxProvider) {
    super(`${operation}() is not supported by the ${provider} provider`, { code: 'SANDBOX_NOT_SUPPORTED', method: operation, provider })
    this.name = 'NotSupportedError'
  }
}
