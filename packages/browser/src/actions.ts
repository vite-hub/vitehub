import runtimeConfig from "#vitehub/browser/runtime"

import {
  browserProviderError,
  browserRuntimeNotConfiguredError,
  toBrowserError,
} from "./errors.ts"

import type {
  BrowserRunAction,
  BrowserRunActionInput,
  BrowserRunActionOptions,
  BrowserRunResult,
} from "./types.ts"

interface BrowserRunBinding {
  quickAction(action: BrowserRunAction, input: Record<string, unknown>): Promise<Response>
}

function normalizeInput(input: BrowserRunActionInput): Record<string, unknown> {
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

async function resolveBinding(options: BrowserRunActionOptions = {}): Promise<BrowserRunBinding> {
  const bindingOption = options.binding ?? runtimeConfig.binding
  if (!bindingOption) throw browserRuntimeNotConfiguredError()
  const binding = typeof bindingOption === "string"
    ? await options.resolveBinding?.(bindingOption) ?? await runtimeBinding(bindingOption)
    : bindingOption
  if (!binding || typeof (binding as BrowserRunBinding).quickAction !== "function") {
    throw browserProviderError("cloudflare", `resolve Browser Run binding ${JSON.stringify(bindingOption)}`)
  }
  return binding as BrowserRunBinding
}

async function readQuickActionText(response: Response, action: BrowserRunAction): Promise<string> {
  if (!response.ok) {
    throw browserProviderError("cloudflare", `run ${action} quick action (${response.status})`)
  }
  return await response.text()
}

export async function runBrowserAction(
  action: BrowserRunAction,
  input: BrowserRunActionInput,
  options?: BrowserRunActionOptions,
): Promise<BrowserRunResult<Response>> {
  try {
    return [null, await (await resolveBinding(options)).quickAction(action, normalizeInput(input))]
  }
  catch (error) {
    return [toBrowserError(error), undefined]
  }
}

export async function runBrowserContent(
  input: BrowserRunActionInput,
  options?: BrowserRunActionOptions,
): Promise<BrowserRunResult<string>> {
  const [error, response] = await runBrowserAction("content", input, options)
  if (error) return [error, undefined]
  try {
    return [null, await readQuickActionText(response, "content")]
  }
  catch (error) {
    return [toBrowserError(error), undefined]
  }
}
