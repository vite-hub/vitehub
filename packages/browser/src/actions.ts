import runtimeConfig from "#vitehub/browser/runtime"

import {
  browserProviderError,
  browserRuntimeNotConfiguredError,
  toBrowserError,
} from "./errors.ts"

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
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return
    for (const [key, nestedValue] of Object.entries(value)) {
      if ((key === "timeout" || key.endsWith("Timeout")) && typeof nestedValue === "number" && nestedValue > 0) {
        requestedTimeoutMs += Math.min(nestedValue, MAX_PROVIDER_TIMEOUT_MS)
      }
      else {
        visit(nestedValue)
      }
    }
  }
  visit(input)
  if (requestedTimeoutMs <= DEFAULT_ACTION_TIMEOUT_MS) return DEFAULT_ACTION_TIMEOUT_MS
  return Math.min(requestedTimeoutMs, MAX_PROVIDER_LIFECYCLE_TIMEOUT_MS) + PROVIDER_TIMEOUT_GRACE_MS
}

async function runtimeBinding(name: string): Promise<unknown> {
  const globalBinding = (globalThis as { __env__?: Record<string, unknown> }).__env__?.[name]
  if (globalBinding) return globalBinding
  try {
    const workers = await import("cloudflare:workers") as { env?: Record<string, unknown> }
    return workers.env?.[name]
  }
  catch {
    return
  }
}

async function resolveBinding(): Promise<BrowserRunBinding> {
  if (runtimeConfig.provider !== "cloudflare") throw browserRuntimeNotConfiguredError()
  const bindingOption = runtimeConfig.binding
  if (!bindingOption) throw browserRuntimeNotConfiguredError()
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
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(async () => {
          const error = browserProviderError("cloudflare", `read ${action} quick action response`)
          timeoutError = error
          try {
            await reader.cancel(error)
          }
          finally {
            reject(error)
          }
        }, actionTimeoutMs(input))
      }),
    ])
  }
  finally {
    if (timer) clearTimeout(timer)
    reader.releaseLock()
  }
}

async function runQuickAction(
  binding: BrowserRunBinding,
  action: BrowserAction,
  input: Record<string, unknown>,
): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      binding.quickAction(action, input),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(browserProviderError("cloudflare", `run ${action} quick action`))
        }, actionTimeoutMs(input))
      }),
    ])
  }
  finally {
    if (timer) clearTimeout(timer)
  }
}

export async function runBrowserAction(
  action: BrowserAction,
  input: BrowserActionInput,
): Promise<BrowserRunResult<Response>> {
  try {
    const binding = await resolveBinding()
    const normalized = normalizeInput(input)
    return [null, await runQuickAction(binding, action, normalized)]
  }
  catch (error) {
    return [toBrowserError(error), undefined]
  }
}

export async function runBrowserContent(
  input: BrowserActionInput,
): Promise<BrowserRunResult<string>> {
  const [error, response] = await runBrowserAction("content", input)
  if (error) return [error, undefined]
  try {
    return [null, await readQuickActionText(response, "content", normalizeInput(input))]
  }
  catch (error) {
    return [toBrowserError(error), undefined]
  }
}
