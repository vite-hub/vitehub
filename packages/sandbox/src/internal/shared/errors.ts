export interface VitehubErrorMetadata {
  code?: string
  provider?: string
  method?: string
  httpStatus?: number
  upstreamError?: unknown
  details?: Record<string, unknown>
  cause?: unknown
}

export class VitehubError extends Error {
  readonly code?: string
  readonly provider?: string
  readonly method?: string
  readonly httpStatus?: number
  readonly upstreamError?: unknown
  readonly details?: Record<string, unknown>
  override readonly cause?: unknown

  constructor(message: string, metadata?: string | VitehubErrorMetadata) {
    super(message)
    this.name = 'VitehubError'
    if (typeof metadata === 'string')
      this.code = metadata
    else if (metadata)
      Object.assign(this, metadata)
  }
}

export class NotSupportedError extends VitehubError {
  constructor(method: string, provider: string, capability?: string) {
    const code = `NOT_SUPPORTED_${(capability || method).toUpperCase()}`
    super(`${method}() is not supported by the ${provider} provider`, {
      code,
      method,
      provider,
      httpStatus: 400,
      details: { capability: capability || method },
    })
    this.name = 'NotSupportedError'
  }
}
