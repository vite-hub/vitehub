import { ViteHubError, type ViteHubErrorOptions } from "@vite-hub/runtime"

export interface QueueErrorMetadata extends ViteHubErrorOptions {
  code?: string
  httpStatus?: number
  method?: string
  provider?: string
}

export interface QueueErrorOptions extends QueueErrorMetadata {
  message: string
}

export class QueueError extends ViteHubError {
  readonly httpStatus?: number
  readonly method?: string
  readonly provider?: string

  constructor(options: QueueErrorOptions)
  constructor(message: string, metadata?: QueueErrorMetadata)
  constructor(messageOrOptions: string | QueueErrorOptions, metadata: QueueErrorMetadata = {}) {
    const options = typeof messageOrOptions === "string" ? metadata : messageOrOptions
    const message = typeof messageOrOptions === "string" ? messageOrOptions : messageOrOptions.message
    super(options.code || "QUEUE_ERROR", message, options)
    this.name = "QueueError"
    this.httpStatus = options.httpStatus
    this.method = options.method
    this.provider = options.provider
  }
}
