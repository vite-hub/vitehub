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

const sandboxOperations = [
  'create', 'createCodeContext', 'createSession', 'deleteCodeContext', 'deleteFile',
  'deleteSession', 'deleteSnapshot', 'destroy', 'exec', 'exposePort', 'extendTimeout',
  'get', 'getExposedPorts', 'getSession', 'getSnapshot', 'gitCheckout', 'list',
  'listCodeContexts', 'listFiles', 'listSnapshots', 'mkdir', 'mountBucket', 'moveFile',
  'readFile', 'readFileStream', 'runCode', 'setEnvVars', 'snapshot', 'startProcess',
  'stop', 'unexposePort', 'unmountBucket', 'updateNetworkPolicy', 'waitForExit',
  'waitForLog', 'waitForPort', 'writeFile', 'wsConnect',
] as const

export type SandboxOperation = typeof sandboxOperations[number]

export interface SandboxErrorDetails extends ViteHubErrorDetails {
  operation?: SandboxOperation
  provider?: SandboxProvider
  status?: number
  timeoutMs?: number
}

export type SandboxErrorJSON = ViteHubErrorShape<SandboxErrorCode, SandboxErrorDetails>

export interface SandboxErrorOptions {
  cause?: unknown
  code: SandboxErrorCode
  details?: ViteHubErrorDetails
  message: string
}

export interface SandboxErrorInternals extends SandboxErrorOptions {
  details?: ViteHubErrorDetails
}

const internalsByError = new WeakMap<SandboxError, SandboxErrorInternals>()
const operations = new Set<string>(sandboxOperations)

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

function safeDetails(details?: ViteHubErrorDetails): SandboxErrorDetails | undefined {
  const operationValue = details?.operation
  const operation = typeof operationValue === 'string' && operations.has(operationValue as SandboxOperation)
    ? operationValue as SandboxOperation
    : undefined
  const provider = details?.provider === 'cloudflare' || details?.provider === 'vercel'
    ? details.provider
    : undefined
  const status = typeof details?.status === 'number'
    && Number.isInteger(details.status)
    && details.status >= 100
    && details.status <= 599
    ? details.status
    : undefined
  const timeoutValue = details?.timeoutMs ?? details?.timeout
  const timeoutMs = typeof timeoutValue === 'number'
    && Number.isFinite(timeoutValue)
    && timeoutValue > 0
    ? timeoutValue
    : undefined

  if (!operation && !provider && !status && !timeoutMs)
    return undefined

  return {
    ...(operation ? { operation } : {}),
    ...(provider ? { provider } : {}),
    ...(status ? { status } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
  }
}

function publicMessage(code: SandboxErrorCode, details?: SandboxErrorDetails) {
  return code === 'SANDBOX_TIMEOUT' && details?.timeoutMs
    ? `Sandbox operation timed out after ${details.timeoutMs}ms.`
    : messages[code]
}

export class SandboxError extends ViteHubError<SandboxErrorCode, SandboxErrorDetails> {
  constructor(options: SandboxErrorOptions) {
    const code = typeof options.code === 'string' && Object.hasOwn(messages, options.code)
      ? options.code
      : 'SANDBOX_RUNTIME_ERROR'
    const details = safeDetails(options.details)
    super(code, publicMessage(code, details), {
      cause: options.cause,
      details,
    })
    this.name = 'SandboxError'
    internalsByError.set(this, { ...options, code })
  }

  override toJSON(): SandboxErrorJSON {
    return super.toJSON()
  }
}

export function readSandboxErrorInternals(error: SandboxError): SandboxErrorInternals {
  return internalsByError.get(error) ?? {
    cause: error.cause,
    code: error.code,
    details: error.details,
    message: error.message,
  }
}

export class NotSupportedError extends SandboxError {
  constructor(operation: string, provider: SandboxProvider) {
    super({
      code: 'SANDBOX_NOT_SUPPORTED',
      details: { operation, provider },
      message: `${operation}() is not supported by the ${provider} provider`,
    })
    this.name = 'NotSupportedError'
  }
}
