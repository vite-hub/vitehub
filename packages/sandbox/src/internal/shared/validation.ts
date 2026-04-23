import { VitehubError } from './errors'

export const VALIDATION_FAILED = 'Validation failed'

export interface ValidationIssue {
  message: string
  path?: readonly unknown[]
  [key: string]: unknown
}

export interface StandardSchemaValidationResult<TOutput = unknown> {
  value: TOutput
  issues?: readonly ValidationIssue[]
}

export interface StandardSchemaValidator<TInput = unknown, TOutput = TInput> {
  '~standard': {
    validate: (input: TInput) => StandardSchemaValidationResult<TOutput> | Promise<StandardSchemaValidationResult<TOutput>>
  }
}

export type ValidationFunction<TInput = unknown, TResult = TInput> = (input: TInput) => TResult | Promise<TResult>

export type ValidationResult<TInput, TResult>
  = TResult extends false | true | null | undefined ? TInput : TResult

export interface ValidationErrorData {
  issues?: readonly ValidationIssue[]
  message: string
  [key: string]: unknown
}

export interface ValidationErrorLike {
  status?: number
  statusCode?: number
  statusText?: string
  statusMessage?: string
  message?: string
  issues?: readonly ValidationIssue[]
  data?: ValidationErrorData
  [key: string]: unknown
}

export interface ValidationErrorContext<TValue = unknown> {
  value?: TValue
  issues?: readonly ValidationIssue[]
}

export interface ValidationOptions<TValue = unknown> {
  onError?: (context: ValidationErrorContext<TValue>) => unknown
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object'
}

function hasStandardValidator<TInput, TOutput>(
  value: unknown,
): value is StandardSchemaValidator<TInput, TOutput> {
  return isObject(value) && '~standard' in value && isObject(value['~standard']) && typeof value['~standard'].validate === 'function'
}

function isErrorWithHttpMetadata(error: unknown): error is Error & ValidationErrorLike {
  if (!(error instanceof Error)) return false
  const e = error as unknown as ValidationErrorLike
  return typeof e.status === 'number' || typeof e.statusCode === 'number'
    || typeof e.statusText === 'string' || typeof e.statusMessage === 'string'
}

function readIssues(value: unknown): readonly ValidationIssue[] | undefined {
  if (!isObject(value))
    return undefined

  if (Array.isArray(value.issues))
    return value.issues as readonly ValidationIssue[]

  if (isObject(value.data) && Array.isArray(value.data.issues))
    return value.data.issues as readonly ValidationIssue[]

  return undefined
}

function readStatusCode(value: unknown): number {
  if (!isObject(value))
    return 400

  if (typeof value.statusCode === 'number')
    return value.statusCode
  if (typeof value.status === 'number')
    return value.status

  return 400
}

function readStatusText(value: unknown): string {
  if (!isObject(value))
    return VALIDATION_FAILED

  if (typeof value.statusMessage === 'string' && value.statusMessage)
    return value.statusMessage
  if (typeof value.statusText === 'string' && value.statusText)
    return value.statusText

  return VALIDATION_FAILED
}

function readMessage(value: unknown): string {
  if (value instanceof Error)
    return value.message || VALIDATION_FAILED
  if (isObject(value) && typeof value.message === 'string' && value.message)
    return value.message

  return VALIDATION_FAILED
}

function readData(value: unknown, issues: readonly ValidationIssue[] | undefined): ValidationErrorData {
  const base = isObject(value) && isObject(value.data) ? { ...value.data } : {}
  const message = value instanceof Error
    ? VALIDATION_FAILED
    : (typeof base.message === 'string' && base.message) || readMessage(value)

  return { ...base, message, ...(issues ? { issues } : {}) } as ValidationErrorData
}

export class VitehubValidationError extends VitehubError {
  readonly status: number
  readonly statusCode: number
  readonly statusText: string
  readonly statusMessage: string
  readonly data: ValidationErrorData

  constructor(cause?: unknown) {
    const statusCode = readStatusCode(cause)
    const statusText = readStatusText(cause)
    const message = readMessage(cause)
    const issues = readIssues(cause)
    const data = readData(cause, issues)

    super(message, {
      cause,
      code: 'VALIDATION_ERROR',
      details: data,
      httpStatus: statusCode,
    })
    this.name = 'VitehubValidationError'
    this.status = statusCode
    this.statusCode = statusCode
    this.statusText = statusText
    this.statusMessage = statusText
    this.data = data
  }
}

export function createValidationError(cause?: unknown): Error {
  if (isErrorWithHttpMetadata(cause))
    return cause

  return new VitehubValidationError(cause)
}

export async function readValidatedPayload<TInput, TOutput>(
  payload: TInput,
  validate: StandardSchemaValidator<TInput, TOutput>,
  options?: ValidationOptions<TInput>,
): Promise<TOutput>
export async function readValidatedPayload<TInput, TResult>(
  payload: TInput,
  validate: ValidationFunction<TInput, TResult>,
  options?: ValidationOptions<TInput>,
): Promise<ValidationResult<TInput, Awaited<TResult>>>
export async function readValidatedPayload<TInput>(
  payload: TInput,
  validate: StandardSchemaValidator<TInput, unknown> | ValidationFunction<TInput, unknown>,
  options?: ValidationOptions<TInput>,
): Promise<unknown> {
  if (hasStandardValidator<TInput, unknown>(validate)) {
    const result = await validate['~standard'].validate(payload)
    if (result.issues?.length) {
      throw createValidationError(options?.onError?.({
        issues: result.issues,
        value: payload,
      }) || {
        issues: result.issues,
        message: VALIDATION_FAILED,
      })
    }

    return result.value
  }

  try {
    const result = await validate(payload)
    if (result === false) {
      throw createValidationError(options?.onError?.({
        issues: [{ message: VALIDATION_FAILED }],
        value: payload,
      }) || {
        message: VALIDATION_FAILED,
      })
    }
    if (result === true || result == null)
      return payload

    return result
  }
  catch (error) {
    throw createValidationError(error)
  }
}
