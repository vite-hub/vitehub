import { ViteHubError } from '@vite-hub/runtime'

import type { ViteHubErrorDetails, ViteHubErrorOptions } from '@vite-hub/runtime'
import type { SandboxProvider } from './types/common'

export type SandboxErrorCode =
  | 'SANDBOX_EXEC_FAILED'
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

export interface SandboxErrorOptions<
  TCode extends string = string,
  TDetails extends ViteHubErrorDetails = ViteHubErrorDetails,
> extends Pick<ViteHubErrorOptions<TDetails>, 'cause' | 'details'> {
  code: TCode
  message: string
}

export class SandboxError<
  TCode extends string = string,
  TDetails extends ViteHubErrorDetails = ViteHubErrorDetails,
> extends ViteHubError<TCode, TDetails> {
  constructor(options: SandboxErrorOptions<TCode, TDetails>) {
    const { code, message, ...errorOptions } = options
    super(code, message, errorOptions)
    this.name = 'SandboxError'
  }
}

export class NotSupportedError extends SandboxError<
  'SANDBOX_NOT_SUPPORTED',
  { operation: string; provider: SandboxProvider }
> {
  constructor(operation: string, provider: SandboxProvider) {
    super({
      code: 'SANDBOX_NOT_SUPPORTED',
      details: { operation, provider },
      message: `${operation}() is not supported by the ${provider} provider`,
    })
    this.name = 'NotSupportedError'
  }
}
