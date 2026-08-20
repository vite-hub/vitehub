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

function normalizeInput(input: BrowserActionInput): Record<string, unknown> {
  return typeof input === "string" ? { url: input } : input
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

async function readQuickActionText(response: Response, action: BrowserAction): Promise<string> {
  if (!response.ok) {
    throw browserProviderError("cloudflare", `run ${action} quick action (${response.status})`)
  }
  return await response.text()
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
        }, DEFAULT_ACTION_TIMEOUT_MS)
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
    return [null, await readQuickActionText(response, "content")]
  }
  catch (error) {
    return [toBrowserError(error), undefined]
  }
}
