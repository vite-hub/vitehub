export class CIProviderError extends Error {
  readonly provider?: string
  readonly statusCode?: number
  readonly cause?: unknown

  constructor(message: string, options: { provider?: string, statusCode?: number, cause?: unknown } = {}) {
    super(message)
    this.name = "CIProviderError"
    this.provider = options.provider
    this.statusCode = options.statusCode
    this.cause = options.cause
  }
}

export class CIAuthError extends CIProviderError {
  constructor(message = "CI provider authentication failed.", options: { provider?: string, statusCode?: number, cause?: unknown } = {}) {
    super(message, options)
    this.name = "CIAuthError"
  }
}

export class CIRateLimitError extends CIProviderError {
  constructor(message = "CI provider rate limit exceeded.", options: { provider?: string, statusCode?: number, cause?: unknown } = {}) {
    super(message, options)
    this.name = "CIRateLimitError"
  }
}

export class CINotFoundError extends CIProviderError {
  constructor(message = "CI provider resource was not found.", options: { provider?: string, statusCode?: number, cause?: unknown } = {}) {
    super(message, options)
    this.name = "CINotFoundError"
  }
}

export class CIMalformedResponseError extends CIProviderError {
  constructor(message = "CI provider returned a malformed response.", options: { provider?: string, statusCode?: number, cause?: unknown } = {}) {
    super(message, options)
    this.name = "CIMalformedResponseError"
  }
}

export class CIUnsupportedCapabilityError extends CIProviderError {
  constructor(message = "CI provider does not support this capability.", options: { provider?: string, statusCode?: number, cause?: unknown } = {}) {
    super(message, options)
    this.name = "CIUnsupportedCapabilityError"
  }
}

export function normalizeProviderError(error: unknown, provider: string): CIProviderError {
  if (error instanceof CIProviderError) {
    return error
  }

  const response = typeof error === "object" && error !== null && "response" in error
    ? (error as { response?: { status?: number, statusText?: string } }).response
    : undefined
  const statusCode = response?.status
  const statusText = response?.statusText
  const message = statusText ? `${provider} request failed: ${statusText}` : `${provider} request failed.`

  if (statusCode === 401 || statusCode === 403) {
    return new CIAuthError(message, { provider, statusCode, cause: error })
  }
  if (statusCode === 404) {
    return new CINotFoundError(message, { provider, statusCode, cause: error })
  }
  if (statusCode === 429) {
    return new CIRateLimitError(message, { provider, statusCode, cause: error })
  }
  return new CIProviderError(message, { provider, statusCode, cause: error })
}
