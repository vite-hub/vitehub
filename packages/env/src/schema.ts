import { envErrorDiagnostics } from "./error-diagnostics.ts"
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
  _zod?: {
    traits?: Set<string>
    constr?: { new (...args: never[]): object, prototype: object }
  }
  parse?: (input: unknown) => unknown
  safeParse?: (input: unknown) => SafeParseFailure | SafeParseSuccess
}

export function parseSchema(schema: unknown, value: unknown, label: string): unknown {
  if (isStandardSchema(schema)) {
    const result = schema["~standard"].validate(value)
    if (isPromiseLike(result)) {
      throw envErrorDiagnostics.ENV_R0014({ message: `[vitehub] ${label} uses an async schema. Env validation currently requires sync schemas.` })
    }
    if ("issues" in result && result.issues && result.issues.length > 0) {
      throw envErrorDiagnostics.ENV_R0015({ message: `[vitehub] Invalid ${label}: ${formatIssues(result.issues)}` })
    }
    if (!("value" in result)) {
      throw envErrorDiagnostics.ENV_R0016({ message: `[vitehub] Invalid ${label}: ${formatIssues(result.issues)}` })
    }
    return result.value
  }

  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Schema objects are untyped user input; validate the method before invoking it.
  if (isZodLike(schema) && hasSchemaMethod(schema, "safeParse") && typeof schema.safeParse === "function") {
    const result = schema.safeParse(value)
    if (!result.success) {
      throw envErrorDiagnostics.ENV_R0017({ message: `[vitehub] Invalid ${label}: ${formatIssues(result.error)}` })
    }
    return result.data
  }

  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Check untyped schema methods before invoking them.
  if (isZodLike(schema) && hasSchemaMethod(schema, "parse") && typeof schema.parse === "function") {
    try {
      return schema.parse(value)
    }
    catch (error) {
      throw envErrorDiagnostics.ENV_R0018({ message: `[vitehub] Invalid ${label}: ${formatIssues(error)}` })
    }
  }

  return value
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return typeof value === "object" && value !== null && "then" in value && typeof value.then === "function"
}

function isStandardSchema(schema: unknown): schema is StandardSchemaV1 {
  return isZodLike(schema)
    && hasSchemaMethod(schema, "~standard")
    && typeof (schema as StandardSchemaV1)["~standard"]?.validate === "function"
}

function isZodLike(schema: unknown): schema is ZodLikeSchema {
  return typeof schema === "object" && schema !== null
}

function hasSchemaMethod(schema: ZodLikeSchema, method: "parse" | "safeParse" | "~standard"): boolean {
  return Object.hasOwn(schema, method) || isZodSchemaMethod(schema, method)
}

function isZodSchemaMethod(schema: ZodLikeSchema, method: string): boolean {
  // Zod 4 records its constructor on the instance. Only accept entry points
  // owned by that constructor's direct prototype, not unrelated ancestors.
  if (!Object.hasOwn(schema, "_zod")) {
    return false
  }
  const metadata = schema._zod
  const constructor = metadata?.constr
  return metadata?.traits instanceof Set
    && metadata.traits.has("ZodType")
    && Object.hasOwn(metadata, "constr")
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Check untyped constructor metadata before using its prototype.
    && typeof constructor === "function"
    && Object.getPrototypeOf(schema) === constructor.prototype
    && Object.hasOwn(constructor.prototype, method)
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
