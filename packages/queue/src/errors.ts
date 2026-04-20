interface QueueErrorMetadata {
  cause?: unknown
  code?: string
  details?: Record<string, unknown>
  httpStatus?: number
  method?: string
  provider?: string
}

export class QueueError extends Error {
  readonly code?: string
  readonly details?: Record<string, unknown>
  readonly httpStatus?: number
  readonly method?: string
  readonly provider?: string
  override readonly cause?: unknown

  constructor(message: string, metadata: QueueErrorMetadata = {}) {
    super(message)
    this.name = "QueueError"
    Object.assign(this, metadata)
  }
}
