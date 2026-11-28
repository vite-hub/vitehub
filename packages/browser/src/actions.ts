import { browserRunErrors } from "./run-errors.ts"
import { runtimeBinding } from "./internal/runtime-binding.ts"
import { withBrowserTimeout } from "./internal/timeout.ts"
import runtimeConfig from "#vitehub/browser/runtime"

import { browserUnavailableError, isBrowserAvailable } from "./availability.ts"
export { isBrowserAvailable } from "./availability.ts"
import {
  browserProviderError,
  toBrowserError,
} from "./errors.ts"

import type { Result } from "@vite-hub/runtime"
import type {
  BrowserAction,
  BrowserActionInput,
  BrowserRunResult,
} from "./types.ts"

interface BrowserRunBinding {
  quickAction(action: BrowserAction, input: Record<string, unknown>): Promise<Response>
}

const DEFAULT_ACTION_TIMEOUT_MS = 30_000
const MAX_PROVIDER_TIMEOUT_MS = 300_000
const MAX_PROVIDER_LIFECYCLE_TIMEOUT_MS = 360_000
const PROVIDER_TIMEOUT_GRACE_MS = 30_000

function normalizeInput(input: BrowserActionInput): Record<string, unknown> {
  return typeof input === "string" ? { url: input } : input
}

function actionTimeoutMs(input: Record<string, unknown>): number {
  let requestedTimeoutMs = 0
  const ancestors = new WeakSet<object>()
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return
    if (ancestors.has(value)) return
    ancestors.add(value)
    try {
      for (const [key, nestedValue] of Object.entries(value)) {
        if ((key === "timeout" || key.endsWith("Timeout")) && typeof nestedValue === "number" && nestedValue > 0) {
          requestedTimeoutMs += Math.min(nestedValue, MAX_PROVIDER_TIMEOUT_MS)
        }
        else {
          visit(nestedValue)
        }
      }
    }
    finally {
      ancestors.delete(value)
    }
  }
  visit(input)
  if (requestedTimeoutMs <= DEFAULT_ACTION_TIMEOUT_MS) return DEFAULT_ACTION_TIMEOUT_MS
  return Math.min(requestedTimeoutMs, MAX_PROVIDER_LIFECYCLE_TIMEOUT_MS) + PROVIDER_TIMEOUT_GRACE_MS
}

async function resolveBinding(): Promise<BrowserRunBinding> {
  const bindingOption = runtimeConfig.binding
  if (!isBrowserAvailable() || runtimeConfig.driver !== "cloudflare" || !bindingOption) throw browserUnavailableError()
  const binding = await runtimeBinding(bindingOption)
  if (!binding || typeof (binding as BrowserRunBinding).quickAction !== "function") {
    throw browserProviderError("cloudflare", `resolve Browser Run binding ${JSON.stringify(bindingOption)}`)
  }
  return binding as BrowserRunBinding
}

async function readQuickActionText(
  response: Response,
  action: BrowserAction,
  input: Record<string, unknown>,
): Promise<string> {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let timeoutError: Error | undefined
  const read = async () => {
    let text = ""
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        if (timeoutError) throw timeoutError
        return text + decoder.decode()
      }
      text += decoder.decode(value, { stream: true })
    }
  }
  try {
    return await withBrowserTimeout(
      read(),
      () => browserProviderError("cloudflare", `read ${action} quick action response`),
      {
        timeoutMs: actionTimeoutMs(input),
        onTimeout(error) {
          timeoutError = error
          void reader.cancel(error).catch(() => {})
        },
      },
    )
  }
  finally {
    try {
      reader.releaseLock()
    }
    catch {}
  }
}

async function runQuickAction(
  binding: BrowserRunBinding,
  action: BrowserAction,
  input: Record<string, unknown>,
): Promise<Response> {
  let timedOut = false
  const response = binding.quickAction(action, input).then((result) => {
    if (timedOut) void result.body?.cancel().catch(() => {})
    return result
  })
  return await withBrowserTimeout(
    response,
    () => browserProviderError("cloudflare", `run ${action} quick action`),
    {
      timeoutMs: actionTimeoutMs(input),
      onTimeout() { timedOut = true },
    },
  )
}

export async function runBrowserAction(
  action: BrowserAction,
  input: BrowserActionInput,
): Promise<BrowserRunResult> {
  try {
    return await runQuickAction(await resolveBinding(), action, normalizeInput(input))
  }
  catch (error) {
    const normalized = toBrowserError(error)
    return Response.json({ error: { code: normalized.code, message: normalized.message, details: normalized.details } }, { status: 500 })
  }
}

function isJsonResponse(response: Response): boolean {
  return response.headers.get("content-type")?.toLowerCase().includes("json") === true
}

function parseQuickActionJson(text: string): { errors?: unknown, result?: unknown, success?: unknown } | undefined {
  try {
    const value: unknown = JSON.parse(text)
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined
  }
  catch {
    return
  }
}

function quickActionErrorMessage(body: { errors?: unknown } | undefined): string | undefined {
  const first: unknown = Array.isArray(body?.errors) ? body.errors[0] : undefined
  if (!first || typeof first !== "object") return
  const { message, detail } = first as { detail?: unknown, message?: unknown }
  if (typeof message !== "string" || !message) return
  return typeof detail === "string" && detail ? `${message} (${detail})` : message
}

/**
 * Read a page as HTML text with the Browser Run `content` action. A failed request returns `BROWSER_CONTENT_FAILED`:
 * its message has the Browser Run error, and `error.cause` has the error when the request did not reach Browser Run.
 */
export async function runBrowserContent(
  input: BrowserActionInput,
): Promise<Result<string, "BROWSER_CONTENT_FAILED">> {
  const normalized = normalizeInput(input)
  let response: Response
  try {
    response = await runQuickAction(await resolveBinding(), "content", normalized)
  }
  catch (error) {
    const cause = toBrowserError(error)
    return [browserRunErrors.BROWSER_CONTENT_FAILED({ cause, reason: cause.message }), undefined]
  }
  if (!response.ok && !isJsonResponse(response)) {
    void response.body?.cancel().catch(() => {})
    return [browserRunErrors.BROWSER_CONTENT_FAILED({ status: response.status }), undefined]
  }
  let text: string
  try {
    text = await readQuickActionText(response, "content", normalized)
  }
  catch (error) {
    const cause = toBrowserError(error)
    return [browserRunErrors.BROWSER_CONTENT_FAILED({ cause, reason: cause.message }), undefined]
  }
  if (!isJsonResponse(response)) return [undefined, text]
  const body = parseQuickActionJson(text)
  if (response.ok && body?.success === true && typeof body.result === "string") return [undefined, body.result]
  if (response.ok && body?.success !== false) return [undefined, text]
  return [browserRunErrors.BROWSER_CONTENT_FAILED({ status: response.status, reason: quickActionErrorMessage(body) }), undefined]
}
