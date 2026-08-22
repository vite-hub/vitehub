import { getViteHubErrorShape } from "./errors.ts"

import type { MaybePromise } from "./index.ts"

export type RuntimeDiagnosticLevel = "debug" | "error" | "info" | "warn"
export type RuntimeResourceScope = "container" | "host" | "process" | "service" | "workload"
export type RuntimeResourceUnit = "bytes" | "count" | "microseconds" | "ratio"

export interface RuntimeDiagnosticError {
  cause?: RuntimeDiagnosticError
  code?: number | string
  details?: Readonly<Record<string, unknown>>
  errors?: readonly RuntimeDiagnosticError[]
  message: string
  name?: string
  requestId?: string
  stack?: string
  status?: number | string
  statusCode?: number | string
}

export interface RuntimeDiagnosticEvent {
  attributes?: Readonly<Record<string, unknown>>
  component: string
  error?: RuntimeDiagnosticError
  level: RuntimeDiagnosticLevel
  name: string
  timestamp: string
}

export type RuntimeDiagnosticReporter = (event: RuntimeDiagnosticEvent) => MaybePromise<void>

export interface RuntimeResourceObservation {
  name: string
  scope: RuntimeResourceScope
  source: string
  unit: RuntimeResourceUnit
  value: number
}

export interface RuntimeResourceSupport {
  reason?: "collection-failed" | "not-isolated" | "permission-denied" | "unsupported-runtime" | (string & {})
  scope: RuntimeResourceScope
  source: string
  supported: boolean
}

export interface RuntimeResourceSnapshot {
  observedAt: string
  observations: readonly RuntimeResourceObservation[]
  support?: readonly RuntimeResourceSupport[]
}

export interface RuntimeResourceInspector {
  inspect(options?: { signal?: AbortSignal }): MaybePromise<RuntimeResourceSnapshot>
}

export interface RuntimeDiagnosticErrorOptions {
  includeStack?: boolean
  maxDepth?: number
  maxErrors?: number
  maxStringLength?: number
}

interface ErrorNormalizationState {
  readonly ancestors: Set<object>
  readonly includeStack: boolean
  readonly maxDepth: number
  readonly maxErrors: number
  readonly maxStringLength: number
}

function boundedString(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return
  if (value.length <= maximum) return value
  const suffix = `… [${value.length - maximum} chars omitted]`
  return maximum > suffix.length ? `${value.slice(0, maximum - suffix.length)}${suffix}` : value.slice(0, maximum)
}

function safeString(value: unknown): string {
  try {
    return String(value)
  }
  catch {
    return "Unknown error"
  }
}

function readProperty(value: object, key: PropertyKey): unknown {
  try {
    return (value as Record<PropertyKey, unknown>)[key]
  }
  catch {
    return undefined
  }
}

function scalarProperty(value: object, key: PropertyKey): number | string | undefined {
  const property = readProperty(value, key)
  return typeof property === "string" || typeof property === "number" && Number.isFinite(property) ? property : undefined
}

function errorChildren(value: unknown, maximum: number): unknown[] | undefined {
  try {
    if (!Array.isArray(value)) return
    const length = Math.min(value.length, maximum)
    return Array.from({ length }, (_item, index) => readProperty(value, index))
  }
  catch {
    return []
  }
}

function normalizeError(value: unknown, state: ErrorNormalizationState, depth: number): RuntimeDiagnosticError {
  if (typeof value === "string") return { message: boundedString(value, state.maxStringLength) || "Error" }
  if (!value || typeof value !== "object") return { message: boundedString(safeString(value), state.maxStringLength) || "Error" }
  if (state.ancestors.has(value)) return { message: "[Circular error cause]" }
  if (depth > state.maxDepth) return { message: "[Error cause depth exceeded]" }

  state.ancestors.add(value)
  try {
    const publicError = getViteHubErrorShape(value)
    const message = boundedString(readProperty(value, "message"), state.maxStringLength)
      || boundedString(safeString(value), state.maxStringLength)
      || "Error"
    const name = boundedString(readProperty(value, "name"), state.maxStringLength)
      || boundedString(readProperty(readProperty(value, "constructor") as object || {}, "name"), state.maxStringLength)
    const result: RuntimeDiagnosticError = {
      message,
      ...(name ? { name } : {}),
    }
    const code = publicError?.code || scalarProperty(value, "code")
    const requestId = publicError?.requestId || boundedString(readProperty(value, "requestId"), state.maxStringLength)
    const status = scalarProperty(value, "status")
    const statusCode = scalarProperty(value, "statusCode")
    const stack = state.includeStack ? boundedString(readProperty(value, "stack"), state.maxStringLength) : undefined
    if (code !== undefined) result.code = code
    if (publicError?.details) result.details = publicError.details
    if (requestId) result.requestId = requestId
    if (stack) result.stack = stack
    if (status !== undefined) result.status = status
    if (statusCode !== undefined) result.statusCode = statusCode

    const cause = readProperty(value, "cause")
    if (cause !== undefined) result.cause = normalizeError(cause, state, depth + 1)
    const errors = errorChildren(readProperty(value, "errors"), state.maxErrors)
    if (errors) result.errors = errors.map(error => normalizeError(error, state, depth + 1))
    return result
  }
  finally {
    state.ancestors.delete(value)
  }
}

export function normalizeRuntimeDiagnosticError(
  error: unknown,
  options: RuntimeDiagnosticErrorOptions = {},
): RuntimeDiagnosticError {
  const maxDepth = options.maxDepth ?? 4
  const maxErrors = options.maxErrors ?? 8
  const maxStringLength = options.maxStringLength ?? 4_096
  if (!Number.isInteger(maxDepth) || maxDepth < 0) throw new TypeError("[vitehub:runtime] Diagnostic error maxDepth must be a non-negative integer.")
  if (!Number.isInteger(maxErrors) || maxErrors < 1) throw new TypeError("[vitehub:runtime] Diagnostic error maxErrors must be a positive integer.")
  if (!Number.isInteger(maxStringLength) || maxStringLength < 64) throw new TypeError("[vitehub:runtime] Diagnostic error maxStringLength must be an integer of at least 64.")
  return normalizeError(error, {
    ancestors: new Set(),
    includeStack: options.includeStack === true,
    maxDepth,
    maxErrors,
    maxStringLength,
  }, 0)
}
