import { hasRuntimeType, isRuntimeObject } from "./internal/runtime-type.ts"
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
  readonly maxStringLength: number
  remainingNodes: number
  remainingStringLength: number
}

function boundedString(value: unknown, state: ErrorNormalizationState): string | undefined {
  if (!hasRuntimeType(value, "string")) return
  const maximum = Math.min(state.maxStringLength, state.remainingStringLength)
  if (maximum <= 0) return
  if (value.length <= maximum) {
    state.remainingStringLength -= value.length
    return value
  }
  const suffix = `… [${value.length - maximum} chars omitted]`
  const bounded = maximum > suffix.length ? `${value.slice(0, maximum - suffix.length)}${suffix}` : value.slice(0, maximum)
  state.remainingStringLength -= bounded.length
  return bounded
}

function safeString(value: unknown): string {
  try {
    return String(value)
  }
  catch {
    return "Unknown error"
  }
}

function readProperty(value: unknown, key: PropertyKey): unknown {
  if (!isRuntimeObject(value)) return undefined
  try {
    // SAFETY: Runtime diagnostic normalization establishes the asserted error record contract.
    return (value as Record<PropertyKey, unknown>)[key]
  }
  catch {
    return undefined
  }
}

function scalarProperty(value: unknown, key: PropertyKey, state: ErrorNormalizationState): number | string | undefined {
  const property = readProperty(value, key)
  if (hasRuntimeType(property, "string")) return boundedString(property, state)
  return hasRuntimeType(property, "number") && Number.isFinite(property) ? property : undefined
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

function normalizeDetailValue(value: unknown, state: ErrorNormalizationState, depth: number): unknown {
  if (state.remainingNodes <= 0) return
  state.remainingNodes -= 1
  if (value === null || hasRuntimeType(value, "boolean")) return value
  if (hasRuntimeType(value, "number")) return Number.isFinite(value) ? value : undefined
  if (hasRuntimeType(value, "string")) return boundedString(value, state)
  if (depth > state.maxDepth) return boundedString("[Detail depth exceeded]", state)
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const normalized = normalizeDetailValue(item, state, depth + 1)
      return normalized === undefined ? [] : [normalized]
    })
  }
  if (!isRuntimeObject(value)) return
  const normalized: Record<string, unknown> = {}
  let keys: string[]
  try {
    keys = Object.keys(value)
  }
  catch {
    return normalized
  }
  for (const key of keys) {
    const normalizedKey = boundedString(key, state)
    if (!normalizedKey) break
    const child = normalizeDetailValue(readProperty(value, key), state, depth + 1)
    if (child !== undefined) normalized[normalizedKey] = child
  }
  return normalized
}

function normalizeDetails(
  details: Readonly<Record<string, unknown>>,
  state: ErrorNormalizationState,
  depth: number,
): Readonly<Record<string, unknown>> | undefined {
  const normalized = normalizeDetailValue(details, state, depth)
  if (!isRuntimeObject(normalized) || Array.isArray(normalized)) return
  // SAFETY: Detail normalization constructs every non-array object as a string-keyed diagnostic record.
  return normalized as Readonly<Record<string, unknown>>
}

function normalizeError(value: unknown, state: ErrorNormalizationState, depth: number): RuntimeDiagnosticError | undefined {
  if (state.remainingNodes <= 0) return
  state.remainingNodes -= 1
  if (hasRuntimeType(value, "string")) return { message: boundedString(value, state) || "Error" }
  if (!value || !hasRuntimeType(value, "object")) return { message: boundedString(safeString(value), state) || "Error" }
  if (state.ancestors.has(value)) return { message: boundedString("[Circular error cause]", state) || "Error" }
  if (depth > state.maxDepth) return { message: boundedString("[Error cause depth exceeded]", state) || "Error" }

  state.ancestors.add(value)
  try {
    const publicError = getViteHubErrorShape(value)
    const message = boundedString(readProperty(value, "message"), state)
      || boundedString(safeString(value), state)
      || "Error"
    const name = boundedString(readProperty(value, "name"), state)
      // SAFETY: Runtime diagnostic normalization establishes the asserted error record contract.
      || boundedString(readProperty(readProperty(value, "constructor") as object || {}, "name"), state)
    const result: RuntimeDiagnosticError = {
      message,
      ...(name ? { name } : {}),
    }
    const code = publicError?.code ? boundedString(publicError.code, state) : scalarProperty(value, "code", state)
    const requestId = publicError?.requestId ? boundedString(publicError.requestId, state) : boundedString(readProperty(value, "requestId"), state)
    const status = scalarProperty(value, "status", state)
    const statusCode = scalarProperty(value, "statusCode", state)
    const stack = state.includeStack ? boundedString(readProperty(value, "stack"), state) : undefined
    if (code !== undefined) result.code = code
    if (requestId) result.requestId = requestId
    if (stack) result.stack = stack
    if (status !== undefined) result.status = status
    if (statusCode !== undefined) result.statusCode = statusCode

    const cause = readProperty(value, "cause")
    const normalizedCause = cause === undefined ? undefined : normalizeError(cause, state, depth + 1)
    if (normalizedCause) result.cause = normalizedCause
    const errors = errorChildren(readProperty(value, "errors"), state.remainingNodes)
    const normalizedErrors = errors?.flatMap((error) => {
      const normalized = normalizeError(error, state, depth + 1)
      return normalized ? [normalized] : []
    })
    if (normalizedErrors?.length) result.errors = normalizedErrors
    const details = publicError?.details ? normalizeDetails(publicError.details, state, depth + 1) : undefined
    if (details) result.details = details
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
    maxStringLength,
    remainingNodes: maxErrors + 1,
    remainingStringLength: maxStringLength * (maxErrors + 1),
  }, 0)!
}
