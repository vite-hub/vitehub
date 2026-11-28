import { browserRunErrors } from "./run-errors.ts"
import { runtimeBinding } from "./internal/runtime-binding.ts"
import { withBrowserTimeout } from "./internal/timeout.ts"
import runtimeConfig from "#vitehub/browser/runtime"

import { browserUnavailableError, isBrowserAvailable } from "./availability.ts"
export { isBrowserAvailable } from "./availability.ts"
import { cdp } from "./controllers/cdp.ts"
import { browserErrorDiagnostics } from "./error-diagnostics.ts"
import {
  browserProviderError,
  toBrowserError,
} from "./errors.ts"
import { attachCDPPage } from "./internal/cdp-page.ts"
import { resolveHostClient, usesBrowserRun } from "./internal/host-client.ts"

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
  if (!response.ok) {
    throw browserProviderError("cloudflare", `run ${action} quick action (${response.status})`)
  }
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

async function readPageContent(input: Record<string, unknown>): Promise<string> {
  const url = input.url
  if (typeof url !== "string" || !url) {
    throw browserErrorDiagnostics.BROWSER_R0015({ message: "[vitehub:browser] The content action on this host reads a page from `url`. Pass a URL." })
  }
  const timeoutMs = actionTimeoutMs(input)
  const session = await (await resolveHostClient()).open()
  try {
    const control = await withBrowserTimeout(session.attach(cdp()), () => browserProviderError("cdp", "attach the browser controller"))
    try {
      const { page } = await attachCDPPage(control.client)
      await page.goto(url, { timeoutMs })
      return await page.content()
    }
    finally {
      await control.release()
    }
  }
  finally {
    await session.close()
  }
}

async function runPageAction(action: BrowserAction, input: Record<string, unknown>): Promise<Response> {
  if (action !== "content") {
    throw browserErrorDiagnostics.BROWSER_R0015({ message: `[vitehub:browser] The ${action} quick action needs Cloudflare Browser Run. This host runs Chromium over CDP.` })
  }
  return new Response(await readPageContent(input), { headers: { "content-type": "text/html; charset=utf-8" } })
}

export async function runBrowserAction(
  action: BrowserAction,
  input: BrowserActionInput,
): Promise<BrowserRunResult> {
  try {
    if (!isBrowserAvailable()) throw browserUnavailableError()
    const normalized = normalizeInput(input)
    if (!usesBrowserRun()) return await runPageAction(action, normalized)
    const binding = await resolveBinding()
    return await runQuickAction(binding, action, normalized)
  }
  catch (error) {
    const normalized = toBrowserError(error)
    return Response.json({ error: { code: normalized.code, message: normalized.message, details: normalized.details } }, { status: 500 })
  }
}

/**
 * Read a page as HTML text: the Browser Run `content` action on Cloudflare, else the page HTML from a CDP session.
 * A failed request returns `BROWSER_CONTENT_FAILED`.
 */
export async function runBrowserContent(
  input: BrowserActionInput,
): Promise<Result<string, "BROWSER_CONTENT_FAILED">> {
  const response = await runBrowserAction("content", input)
  if (!response.ok) {
    void response.body?.cancel().catch(() => {})
    return [browserRunErrors.BROWSER_CONTENT_FAILED({ status: response.status }), undefined]
  }
  try {
    return [undefined, await readQuickActionText(response, "content", normalizeInput(input))]
  }
  catch (error) {
    return [browserRunErrors.BROWSER_CONTENT_FAILED({ cause: toBrowserError(error) }), undefined]
  }
}
