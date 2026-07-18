import { ViteHubError } from "@vite-hub/runtime"

const scheduleErrorCodes = [
  "SCHEDULE_ALREADY_EXISTS",
  "SCHEDULE_DISABLED",
  "SCHEDULE_INVALID_CRON",
  "SCHEDULE_INVALID_ENABLED",
  "SCHEDULE_INVALID_ID",
  "SCHEDULE_INVALID_INPUT",
  "SCHEDULE_INVALID_SCHEDULED_AT",
  "SCHEDULE_INVALID_TARGET",
  "SCHEDULE_INVALID_TIME_ZONE",
  "SCHEDULE_NOT_DUE",
  "SCHEDULE_NOT_FOUND",
  "SCHEDULE_RUN_NOT_FOUND",
  "SCHEDULE_TARGET_NOT_ELIGIBLE",
  "SCHEDULE_TARGET_NOT_FOUND",
] as const

const scheduleErrorFields = [
  "cron",
  "enabled",
  "id",
  "input",
  "options",
  "scheduledAt",
  "target",
  "timeZone",
] as const

const scheduleErrorValueTypes = [
  "array",
  "bigint",
  "boolean",
  "date",
  "function",
  "null",
  "number",
  "object",
  "string",
  "symbol",
  "undefined",
  "unknown",
] as const

export type ScheduleErrorCode = typeof scheduleErrorCodes[number]
export type ScheduleErrorField = typeof scheduleErrorFields[number]
export type ScheduleErrorValueType = typeof scheduleErrorValueTypes[number]
export type ScheduleValidationErrorCode = Extract<ScheduleErrorCode, `SCHEDULE_INVALID_${string}`>

export type ScheduleErrorDetails = {
  field: ScheduleErrorField
  valueType: ScheduleErrorValueType
}

export type ScheduleErrorOptions<TCode extends ScheduleErrorCode = ScheduleErrorCode> = ErrorOptions & {
  requestId?: string
} & (TCode extends ScheduleValidationErrorCode ? { details?: ScheduleErrorDetails } : { details?: never })

const scheduleErrorMessages: Record<ScheduleErrorCode, string> = {
  SCHEDULE_ALREADY_EXISTS: "Runtime Schedule already exists.",
  SCHEDULE_DISABLED: "Runtime Schedule is disabled.",
  SCHEDULE_INVALID_CRON: "Runtime Schedule cron is invalid.",
  SCHEDULE_INVALID_ENABLED: "Runtime Schedule enabled value is invalid.",
  SCHEDULE_INVALID_ID: "Runtime Schedule id is invalid.",
  SCHEDULE_INVALID_INPUT: "Runtime Schedule input is invalid.",
  SCHEDULE_INVALID_SCHEDULED_AT: "Runtime Schedule scheduledAt value is invalid.",
  SCHEDULE_INVALID_TARGET: "Runtime Schedule target is invalid.",
  SCHEDULE_INVALID_TIME_ZONE: "Runtime Schedule time zone is invalid.",
  SCHEDULE_NOT_DUE: "Runtime Schedule is not due.",
  SCHEDULE_NOT_FOUND: "Runtime Schedule was not found.",
  SCHEDULE_RUN_NOT_FOUND: "Schedule Run was not found.",
  SCHEDULE_TARGET_NOT_ELIGIBLE: "Runtime Schedule target is not eligible.",
  SCHEDULE_TARGET_NOT_FOUND: "Runtime Schedule target was not found.",
}

const scheduleErrorHttpStatuses: Record<ScheduleErrorCode, number> = {
  SCHEDULE_ALREADY_EXISTS: 409,
  SCHEDULE_DISABLED: 409,
  SCHEDULE_INVALID_CRON: 400,
  SCHEDULE_INVALID_ENABLED: 400,
  SCHEDULE_INVALID_ID: 400,
  SCHEDULE_INVALID_INPUT: 400,
  SCHEDULE_INVALID_SCHEDULED_AT: 400,
  SCHEDULE_INVALID_TARGET: 400,
  SCHEDULE_INVALID_TIME_ZONE: 400,
  SCHEDULE_NOT_DUE: 409,
  SCHEDULE_NOT_FOUND: 404,
  SCHEDULE_RUN_NOT_FOUND: 500,
  SCHEDULE_TARGET_NOT_ELIGIBLE: 400,
  SCHEDULE_TARGET_NOT_FOUND: 404,
}

const scheduleErrorCodeSet = new Set<string>(scheduleErrorCodes)
const scheduleErrorFieldSet = new Set<string>(scheduleErrorFields)
const scheduleErrorValueTypeSet = new Set<string>(scheduleErrorValueTypes)

function readProperty(value: object, key: PropertyKey): unknown {
  try {
    return Reflect.get(value, key)
  }
  catch {
    return undefined
  }
}

function normalizeScheduleErrorCode(code: unknown): ScheduleErrorCode {
  if (typeof code !== "string" || !scheduleErrorCodeSet.has(code)) {
    throw new TypeError("[vitehub] ScheduleError requires a supported Schedule error code.")
  }
  return code as ScheduleErrorCode
}

function normalizeScheduleErrorDetails(value: unknown): ScheduleErrorDetails | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const field = readProperty(value, "field")
  const valueType = readProperty(value, "valueType")
  if (typeof field !== "string" || !scheduleErrorFieldSet.has(field)) return undefined
  if (typeof valueType !== "string" || !scheduleErrorValueTypeSet.has(valueType)) return undefined
  return { field: field as ScheduleErrorField, valueType: valueType as ScheduleErrorValueType }
}

function normalizeScheduleErrorOptions(code: ScheduleErrorCode, value: unknown): Required<Pick<ErrorOptions, "cause">> & { details?: ScheduleErrorDetails, requestId?: string } {
  if (typeof value !== "object" || value === null) return { cause: undefined }
  const requestId = readProperty(value, "requestId")
  return {
    cause: readProperty(value, "cause"),
    ...(code.startsWith("SCHEDULE_INVALID_") ? { details: normalizeScheduleErrorDetails(readProperty(value, "details")) } : {}),
    ...(typeof requestId === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(requestId) ? { requestId } : {}),
  }
}

export function invalidScheduleValueDetails(field: ScheduleErrorField, value: unknown): ScheduleErrorDetails {
  let valueType: ScheduleErrorValueType
  try {
    valueType = value === null
      ? "null"
      : Array.isArray(value)
        ? "array"
        : value instanceof Date
          ? "date"
          : typeof value
  }
  catch {
    valueType = "unknown"
  }
  return { field, valueType }
}

export function assertRuntimeScheduleId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !id.trim()) {
    throw new ScheduleError("SCHEDULE_INVALID_ID", {
      details: invalidScheduleValueDetails("id", id),
    })
  }
}

export class ScheduleError<TCode extends ScheduleErrorCode = ScheduleErrorCode> extends ViteHubError<TCode, ScheduleErrorDetails> {
  readonly httpStatus: number

  constructor(code: TCode, options?: ScheduleErrorOptions<TCode>) {
    const normalizedCode = normalizeScheduleErrorCode(code)
    const normalizedOptions = normalizeScheduleErrorOptions(normalizedCode, options)
    super(normalizedCode as TCode, scheduleErrorMessages[normalizedCode], normalizedOptions)
    this.name = "ScheduleError"
    this.httpStatus = scheduleErrorHttpStatuses[normalizedCode]
  }
}
