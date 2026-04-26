export interface WorkflowErrorOptions {
  cause?: unknown
  code?: string
  details?: Record<string, unknown>
  httpStatus?: number
  provider?: string
}

export class WorkflowError extends Error {
  readonly code?: string
  readonly details?: Record<string, unknown>
  readonly httpStatus?: number
  readonly provider?: string

  constructor(message: string, options: WorkflowErrorOptions = {}) {
    super(message)
    this.name = "WorkflowError"
    this.cause = options.cause
    this.code = options.code
    this.details = options.details
    this.httpStatus = options.httpStatus
    this.provider = options.provider
  }
}
