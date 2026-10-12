import { Diagnostic, type DiagnosticJSON } from "nostics"
import { defineDiagnostics } from "nostics"

import type { MaybePromise } from "./index.ts"
import { runtimeErrorDiagnostics } from "./error-diagnostics.ts"
import { hasRuntimeType } from "./internal/runtime-type.ts"

/** The small set of runtime facts that a preflight check can describe. */
export type RuntimePreflightKind = "browser" | "command" | "file" | "mcp" | "tool" | (string & {})

export type RuntimePreflightState = "available" | "missing" | "unknown"

export type RuntimePreflightValue = string | number | boolean | null

/** Safe, bounded details for a check. Do not put credentials or command output here. */
export type RuntimePreflightDetails = Readonly<Record<string, RuntimePreflightValue>>

export interface RuntimePreflightCheckContext {
  signal: AbortSignal
}

export interface RuntimePreflightCheckResult {
  state: RuntimePreflightState
  details?: RuntimePreflightDetails
  reason?: string
}

export interface RuntimePreflightCheck {
  /** Stable local identifier, for example `command:git` or `file:AGENTS.md`. */
  id: string
  kind: RuntimePreflightKind
  /** Required only affects the diagnostic metadata. Missing optional checks never fail an invocation. */
  required?: boolean
  /**
   * Return a result or a Promise. External process, filesystem, and network work
   * must use non-blocking async APIs and honor `signal`; ViteHub cannot interrupt
   * a synchronous callback, so an over-budget synchronous callback is marked
   * unknown only after it returns.
   */
  check: (context: RuntimePreflightCheckContext) => MaybePromise<RuntimePreflightCheckResult | RuntimePreflightState | boolean>
}

export type RuntimePreflightDiagnosticData = Record<string, unknown> & {
  checkId: string
  kind: RuntimePreflightKind
  required: boolean
  state: RuntimePreflightState
  reason?: string
}

const preflightDiagnostics = defineDiagnostics({
  docsBase: () => "https://vitehub.dev/docs/reference/errors-diagnostics#runtime-preflight",
  codes: {
    RUNTIME_R0012: {
      why: ({ checkId, kind }: RuntimePreflightDiagnosticData) => `Runtime preflight could not find ${kind} capability "${checkId}".`,
      fix: "Provide the capability in the execution environment, or mark this check optional when the Agent can continue without it.",
      data: (params: RuntimePreflightDiagnosticData) => params,
    },
    RUNTIME_R0013: {
      why: ({ checkId, kind }: RuntimePreflightDiagnosticData) => `Runtime preflight could not verify ${kind} capability "${checkId}".`,
      fix: "Inspect the check reason and verify the capability from the same runtime that starts the Agent.",
      data: (params: RuntimePreflightDiagnosticData) => params,
    },
  },
})

export interface RuntimePreflightIssue {
  check: Pick<RuntimePreflightCheck, "id" | "kind" | "required">
  state: RuntimePreflightState
  diagnostic: Diagnostic<RuntimePreflightDiagnosticData>
}

export interface RuntimePreflightCheckSummary {
  id: string
  kind: RuntimePreflightKind
  required: boolean
  state: RuntimePreflightState
  details?: RuntimePreflightDetails
  reason?: string
  diagnostic?: DiagnosticJSON<RuntimePreflightDiagnosticData>
}

/** Compact, serializable result suitable for Agent inspection and telemetry. */
export interface RuntimePreflightManifest {
  version: 1
  checkedAt: string
  durationMs: number
  checks: readonly RuntimePreflightCheckSummary[]
  capabilities: Readonly<Record<string, RuntimePreflightState>>
  diagnostics: readonly DiagnosticJSON<RuntimePreflightDiagnosticData>[]
}

export interface RuntimePreflightOptions {
  checks: readonly RuntimePreflightCheck[]
  /** Maximum wait for one asynchronous check. Synchronous checks are measured after return. Defaults to 250ms. */
  timeoutMs?: number
  /** Maximum checks run for one preflight. Defaults to 32. */
  maxChecks?: number
  signal?: AbortSignal
  /** Best-effort callback. Its work never delays or fails the manifest. */
  onDiagnostic?: (issue: RuntimePreflightIssue) => MaybePromise<void>
}

export interface RuntimePreflightHandle {
  /** Resolves even when checks fail, time out, or the optional reporter fails. */
  manifest: Promise<RuntimePreflightManifest>
  cancel: () => void
}

const maxReasonLength = 256
const maxDetailCount = 12
const maxCheckIdLength = 128
const maxCheckKindLength = 64

function normalizeReason(value: unknown): string | undefined {
  if (!hasRuntimeType(value, "string")) return
  const reason = value.slice(0, maxReasonLength).trim()
  return reason || undefined
}

function normalizeThrownReason(value: unknown): string | undefined {
  try {
    return normalizeReason(value instanceof Error ? value.message : value)
  }
  catch {
    return
  }
}

function normalizeDetails(value: unknown): RuntimePreflightDetails | undefined {
  if (value === null || !hasRuntimeType(value, "object") || Array.isArray(value)) return
  const details: Record<string, RuntimePreflightValue> = {}
  let count = 0
  for (const key in value) {
    if (count++ >= maxDetailCount) break
    if (!key || key.length > 64) continue
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !("value" in descriptor)) continue
    const child: unknown = descriptor.value
    if (child === null || hasRuntimeType(child, "string") || hasRuntimeType(child, "boolean") || (hasRuntimeType(child, "number") && Number.isFinite(child))) {
      Object.defineProperty(details, key, { value: hasRuntimeType(child, "string") ? child.slice(0, maxReasonLength) : child, enumerable: true })
    }
  }
  return Object.keys(details).length ? details : undefined
}

function normalizeResult(value: unknown): RuntimePreflightCheckResult {
  if (value === true) return { state: "available" }
  if (value === false) return { state: "missing" }
  if (value === "available" || value === "missing" || value === "unknown") return { state: value }
  if (value !== null && hasRuntimeType(value, "object") && !Array.isArray(value)) {
    // SAFETY: The object guard above establishes the record shape read below.
    const result = value as Partial<RuntimePreflightCheckResult>
    const rawState = result.state
    let validState = false
    let state: RuntimePreflightState = "unknown"
    if (rawState === "available" || rawState === "missing" || rawState === "unknown") {
      validState = true
      state = rawState
    }
    const normalized: RuntimePreflightCheckResult = { state }
    const details = normalizeDetails(result.details)
    if (details) normalized.details = details
    const reason = normalizeReason(result.reason)
    if (reason) normalized.reason = reason
    else if (!validState) normalized.reason = "The preflight check returned an invalid result."
    return normalized
  }
  return { state: "unknown", reason: "The preflight check returned an invalid result." }
}

function timeoutSignal(parent: AbortSignal, timeoutMs: number): { signal: AbortSignal, deadline: number, cancel: () => void, expire: () => void } {
  const controller = new AbortController()
  const abort = () => controller.abort(parent.reason)
  const expire = () => controller.abort(new Error("The preflight check timed out."))
  if (parent.aborted) abort()
  else parent.addEventListener("abort", abort, { once: true })
  const deadline = Date.now() + timeoutMs
  const timer = setTimeout(() => controller.abort(new Error("Runtime preflight check timed out.")), timeoutMs)
  const cancel = () => {
    clearTimeout(timer)
    parent.removeEventListener("abort", abort)
  }
  return { signal: controller.signal, deadline, cancel, expire }
}

async function resolveCheck(check: RuntimePreflightCheck, signal: AbortSignal, deadline: number, expire: () => void): Promise<RuntimePreflightCheckResult> {
  let removeAbortListener: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    const rejectAbort = () => reject(signal.reason || new Error("Runtime preflight check was aborted."))
    if (signal.aborted) rejectAbort()
    else {
      signal.addEventListener("abort", rejectAbort, { once: true })
      removeAbortListener = () => signal.removeEventListener("abort", rejectAbort)
    }
  })
  const operation = Promise.resolve().then(() => {
    if (signal.aborted) throw signal.reason || new Error("Runtime preflight check was aborted.")
    if (Date.now() >= deadline) {
      expire()
      return { state: "unknown", reason: "The preflight check timed out." } satisfies RuntimePreflightCheckResult
    }
    const value = check.check({ signal })
    // A synchronous callback blocks the event loop, so its timer cannot fire
    // until the callback returns. Apply the same deadline after it returns.
    if (Date.now() >= deadline) {
      expire()
      // Do not leave a thenable returned by an over-budget callback unobserved.
      void Promise.resolve(value).catch(() => undefined)
      return { state: "unknown", reason: "The preflight check timed out." } satisfies RuntimePreflightCheckResult
    }
    return value
  })
  // The abort race owns completion, but the check may still reject after it loses the race.
  void operation.catch(() => undefined)
  try {
    const result = normalizeResult(await Promise.race([operation, aborted]))
    if (Date.now() >= deadline) {
      expire()
      return { state: "unknown", reason: "The preflight check timed out." }
    }
    return result
  }
  finally { removeAbortListener?.() }
}

function diagnosticFor(check: RuntimePreflightCheck, state: RuntimePreflightState, reason?: string): Diagnostic<RuntimePreflightDiagnosticData> | undefined {
  if (state === "available") return
  const params: RuntimePreflightDiagnosticData = { checkId: check.id, kind: check.kind, required: check.required === true, state }
  if (reason) params.reason = reason
  return state === "missing"
    ? preflightDiagnostics.RUNTIME_R0012(params)
    : preflightDiagnostics.RUNTIME_R0013(params)
}

function snapshotRuntimePreflightCheck(value: unknown): RuntimePreflightCheck | undefined {
  if (value === null || !hasRuntimeType(value, "object")) return
  try {
    const id = Reflect.get(value, "id")
    const kind = Reflect.get(value, "kind")
    const check = Reflect.get(value, "check")
    const required = Reflect.get(value, "required")
    if (!hasRuntimeType(id, "string") || !hasRuntimeType(kind, "string") || !hasRuntimeType(check, "function")) return
    // SAFETY: The runtime boundary verified a callable; resolveCheck supplies the documented context and normalizeResult validates its output.
    const callback = check as RuntimePreflightCheck["check"]
    return { id, kind, check: callback, required: required === true }
  }
  catch {
    return
  }
}

function validateOptions(options: RuntimePreflightOptions): { checks: RuntimePreflightCheck[], timeoutMs: number, maxChecks: number } {
  if (!options || !Array.isArray(options.checks)) throw runtimeErrorDiagnostics.RUNTIME_R0014({ message: "[vitehub] Runtime preflight checks must be an array." })
  const timeoutMs = options.timeoutMs ?? 250
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) throw runtimeErrorDiagnostics.RUNTIME_R0014({ message: "[vitehub] Runtime preflight timeoutMs must be between 1 and 10000." })
  const maxChecks = options.maxChecks ?? 32
  if (!Number.isSafeInteger(maxChecks) || maxChecks < 1 || maxChecks > 128) throw runtimeErrorDiagnostics.RUNTIME_R0014({ message: "[vitehub] Runtime preflight maxChecks must be between 1 and 128." })
  if (options.checks.length > maxChecks) throw runtimeErrorDiagnostics.RUNTIME_R0014({ message: `[vitehub] Runtime preflight checks exceed maxChecks (${maxChecks}).` })
  const checks: RuntimePreflightCheck[] = []
  const ids = new Set<string>()
  for (const value of options.checks) {
    const check = snapshotRuntimePreflightCheck(value)
    if (!check || !check.id.trim() || !check.kind.trim()) {
      throw runtimeErrorDiagnostics.RUNTIME_R0014({ message: "[vitehub] Runtime preflight checks require an id, kind, and check function." })
    }
    if (check.id.length > maxCheckIdLength) throw runtimeErrorDiagnostics.RUNTIME_R0014({ message: `[vitehub] Runtime preflight check id must be at most ${maxCheckIdLength} characters.` })
    if (check.kind.length > maxCheckKindLength) throw runtimeErrorDiagnostics.RUNTIME_R0014({ message: `[vitehub] Runtime preflight check kind must be at most ${maxCheckKindLength} characters.` })
    if (ids.has(check.id)) throw runtimeErrorDiagnostics.RUNTIME_R0014({ message: `[vitehub] Runtime preflight check "${check.id}" is duplicated.` })
    ids.add(check.id)
    checks.push(check)
  }
  return { checks, timeoutMs, maxChecks }
}

/**
 * Start bounded capability checks without making them part of the invocation's critical path.
 * Checks run in parallel and settle to a manifest; failures are represented as diagnostics.
 */
export function startRuntimePreflight(options: RuntimePreflightOptions): RuntimePreflightHandle {
  const normalized = validateOptions(options)
  const signal = options.signal
  const onDiagnostic = options.onDiagnostic
  const controller = new AbortController()
  const abort = () => controller.abort(signal?.reason)
  if (signal?.aborted) abort()
  else signal?.addEventListener("abort", abort, { once: true })
  let settled = false
  const startedAt = Date.now()
  const manifest = Promise.resolve().then(async () => {
    const results = await Promise.all(normalized.checks.map(async check => {
      const bounded = timeoutSignal(controller.signal, normalized.timeoutMs)
      let result: RuntimePreflightCheckResult
      try {
        result = await resolveCheck(check, bounded.signal, bounded.deadline, bounded.expire)
        if (bounded.signal.aborted && !controller.signal.aborted) result = { state: "unknown", reason: "The preflight check timed out." }
      }
      catch (error) {
        result = {
          state: "unknown",
          reason: normalizeThrownReason(error) || "The preflight check failed.",
        }
      }
      finally { bounded.cancel() }
      const diagnostic = diagnosticFor(check, result.state, result.reason)
      const issue = diagnostic ? { check, state: result.state, diagnostic } satisfies RuntimePreflightIssue : undefined
      const summary: RuntimePreflightCheckSummary = {
        id: check.id,
        kind: check.kind,
        required: check.required === true,
        state: result.state,
      }
      if (result.details) summary.details = result.details
      if (result.reason) summary.reason = result.reason
      if (diagnostic) summary.diagnostic = diagnostic.toJSON()
      return { issue, summary }
    }))
    const summaries = results.map(result => result.summary)
    const capabilities = Object.fromEntries(summaries.map(summary => [summary.id, summary.state]))
    const manifest = {
      version: 1 as const,
      checkedAt: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - startedAt),
      checks: summaries,
      capabilities,
      diagnostics: summaries.flatMap(summary => summary.diagnostic ? [summary.diagnostic] : []),
    }
    if (onDiagnostic) {
      const issues = results.flatMap(({ issue }) => issue ? [issue] : [])
      setTimeout(() => {
        for (const issue of issues) {
          void Promise.resolve().then(() => onDiagnostic(issue)).catch(() => undefined)
        }
      }, 0)
    }
    return manifest
  }).finally(() => {
    settled = true
    signal?.removeEventListener("abort", abort)
  })
  return {
    manifest,
    cancel() {
      if (!settled) controller.abort(new Error("Runtime preflight cancelled."))
    },
  }
}

export async function runRuntimePreflight(options: RuntimePreflightOptions): Promise<RuntimePreflightManifest> {
  return await startRuntimePreflight(options).manifest
}
