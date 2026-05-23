export interface ScheduleErrorOptions {
  cause?: unknown
  code?: string
  details?: unknown
  httpStatus?: number
}

export class ScheduleError extends Error {
  code?: string
  details?: unknown
  httpStatus?: number

  constructor(message: string, options: ScheduleErrorOptions = {}) {
    super(message, { cause: options.cause })
    this.name = "ScheduleError"
    this.code = options.code
    this.details = options.details
    this.httpStatus = options.httpStatus
  }
}
