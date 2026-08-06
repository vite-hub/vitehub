import { browserProviderError } from "../errors.ts"
import { cloudflareBrowserTerminated } from "../internal/connections.ts"

import type { BrowserEngine, BrowserProvider } from "../types.ts"
import type { CloudflareBrowserBindingConnection } from "../internal/connections.ts"

interface CloudflareBrowserHandle {
  close(): Promise<void>
  newBrowserCDPSession(): Promise<{
    detach(): Promise<void>
    send(method: string): Promise<unknown>
  }>
}

export interface CloudflarePlaywrightDriver {
  acquire(binding: unknown, options?: { keep_alive?: number }): Promise<{ sessionId: string }>
  connect(binding: unknown, sessionId: string): Promise<CloudflareBrowserHandle>
}

export interface CloudflareBrowserOptions {
  binding?: string | unknown
  driver?: CloudflarePlaywrightDriver
  engine?: BrowserEngine
  resolveBinding?: (name: string) => unknown | Promise<unknown>
}

async function loadDriver(): Promise<CloudflarePlaywrightDriver> {
  try {
    return await import("@cloudflare/playwright") as unknown as CloudflarePlaywrightDriver
  }
  catch (error) {
    throw browserProviderError("cloudflare", "load @cloudflare/playwright", { cause: error })
  }
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

export function cloudflareBrowser(options: CloudflareBrowserOptions = {}): BrowserProvider<CloudflareBrowserBindingConnection> {
  const bindingOption = options.binding ?? "BROWSER"
  const engine = options.engine ?? "kitesurf"
  return {
    features: {
      liveHandoff: engine === "chromium",
    },
    isolation: "provider",
    name: "cloudflare",
    async open(openOptions = {}) {
      const binding = typeof bindingOption === "string"
        ? await options.resolveBinding?.(bindingOption) ?? await runtimeBinding(bindingOption)
        : bindingOption
      if (!binding) {
        throw browserProviderError("cloudflare", `resolve Browser Run binding ${JSON.stringify(bindingOption)}`)
      }
      if (engine === "kitesurf") {
        if (openOptions.idleTimeoutMs !== undefined) {
          throw browserProviderError("cloudflare", "configure an idle timeout for Kitesurf")
        }
        return {
          close() {},
          connection: {
            binding,
            engine,
            kind: "cloudflare-binding",
          },
          features: { liveHandoff: false },
          id: crypto.randomUUID(),
        }
      }
      const driver = options.driver || await loadDriver()
      let acquired: { sessionId: string }
      try {
        acquired = openOptions.idleTimeoutMs
          ? await driver.acquire(binding, { keep_alive: openOptions.idleTimeoutMs })
          : await driver.acquire(binding)
      }
      catch (error) {
        throw browserProviderError("cloudflare", "acquire a Browser Run session", { cause: error })
      }
      let closed = false
      const connection: CloudflareBrowserBindingConnection = {
        binding,
        kind: "cloudflare-binding",
        sessionId: acquired.sessionId,
      }
      return {
        async close() {
          if (closed) return
          if (connection[cloudflareBrowserTerminated]) {
            closed = true
            return
          }
          try {
            const browser = await driver.connect(binding, acquired.sessionId)
            const cdp = await browser.newBrowserCDPSession()
            await cdp.send("Browser.close")
            connection[cloudflareBrowserTerminated] = true
            closed = true
          }
          catch (error) {
            throw browserProviderError("cloudflare", "terminate a Browser Run session", { cause: error })
          }
        },
        connection,
        id: acquired.sessionId,
      }
    },
  }
}

export type { CloudflareBrowserBindingConnection } from "../internal/connections.ts"
