export type ViteHubErrorDetail =
  | boolean
  | null
  | number
  | string
  | readonly ViteHubErrorDetail[]
  | { readonly [key: string]: ViteHubErrorDetail | undefined }

export type ViteHubErrorDetails = Readonly<Record<string, ViteHubErrorDetail | undefined>>

export interface ViteHubErrorShape<
  TCode extends string = string,
  TDetails extends ViteHubErrorDetails = ViteHubErrorDetails,
> {
  code: TCode
  details?: TDetails
  message: string
  requestId?: string
  retryable?: boolean
}

export interface ViteHubErrorOptions<TDetails extends ViteHubErrorDetails = ViteHubErrorDetails> extends ErrorOptions {
  details?: TDetails
  requestId?: string
  retryable?: boolean
}

export class ViteHubError<
  TCode extends string = string,
  TDetails extends ViteHubErrorDetails = ViteHubErrorDetails,
> extends Error {
  readonly code: TCode
  readonly details?: TDetails
  readonly requestId?: string
  readonly retryable?: boolean

  constructor(code: TCode, message: string, options: ViteHubErrorOptions<TDetails> = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = "ViteHubError"
    this.code = code
    this.details = options.details
    this.requestId = options.requestId
    this.retryable = options.retryable
  }

  toJSON(): ViteHubErrorShape<TCode, TDetails> {
    return {
      code: this.code,
      ...(this.details === undefined ? {} : { details: this.details }),
      message: this.message,
      ...(this.requestId === undefined ? {} : { requestId: this.requestId }),
      ...(this.retryable === undefined ? {} : { retryable: this.retryable }),
    }
  }
}
