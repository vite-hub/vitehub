export interface StandardSchemaResultSuccess<T = unknown> {
  issues?: undefined
  value: T
}

export interface StandardSchemaResultFailure {
  issues: readonly unknown[]
}

export interface StandardSchemaV1<T = unknown> {
  "~standard": {
    validate: (input: unknown) => StandardSchemaResultSuccess<T> | StandardSchemaResultFailure | Promise<StandardSchemaResultSuccess<T> | StandardSchemaResultFailure>
  }
}

interface SafeParseSuccess {
  data: unknown
  success: true
}

interface SafeParseFailure {
  error: unknown
  success: false
}

interface ZodLikeSchema {
  parse?: (input: unknown) => unknown
  safeParse?: (input: unknown) => SafeParseFailure | SafeParseSuccess
}

export function parseSchema(schema: unknown, value: unknown, label: string): unknown {
  if (isStandardSchema(schema)) {
    const result = schema["~standard"].validate(value)
    if (isPromiseLike(result)) {
      throw new Error(`[vitehub] ${label} uses an async schema. Env validation currently requires sync schemas.`)
    }
    if ("issues" in result && result.issues && result.issues.length > 0) {
      throw new Error(`[vitehub] Invalid ${label}: ${formatIssues(result.issues)}`)
    }
    if (!("value" in result)) {
      throw new Error(`[vitehub] Invalid ${label}: ${formatIssues(result.issues)}`)
    }
    return result.value
  }

  if (isZodLike(schema) && typeof schema.safeParse === "function") {
    const result = schema.safeParse(value)
    if (!result.success) {
      throw new Error(`[vitehub] Invalid ${label}: ${formatIssues(result.error)}`)
    }
    return result.data
  }

  if (isZodLike(schema) && typeof schema.parse === "function") {
    try {
      return schema.parse(value)
    }
    catch (error) {
      throw new Error(`[vitehub] Invalid ${label}: ${formatIssues(error)}`)
    }
  }

  return value
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return typeof value === "object" && value !== null && "then" in value && typeof value.then === "function"
}

function isStandardSchema(schema: unknown): schema is StandardSchemaV1 {
  return typeof schema === "object"
    && schema !== null
    && "~standard" in schema
    && typeof (schema as StandardSchemaV1)["~standard"]?.validate === "function"
}

function isZodLike(schema: unknown): schema is ZodLikeSchema {
  return typeof schema === "object" && schema !== null
}

function formatIssues(issues: unknown): string {
  if (Array.isArray(issues)) {
    return issues.map(issue => typeof issue === "string" ? issue : JSON.stringify(issue)).join("; ")
  }
  if (issues instanceof Error) {
    return issues.message
  }
  return typeof issues === "string" ? issues : JSON.stringify(issues)
}
