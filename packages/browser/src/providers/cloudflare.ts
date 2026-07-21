import { BrowserProviderError } from "../errors.ts"

import type { BrowserProvider } from "../types.ts"
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
  resolveBinding?: (name: string) => unknown | Promise<unknown>
}

async function loadDriver(): Promise<CloudflarePlaywrightDriver> {
  try {
    return await import("@cloudflare/playwright") as unknown as CloudflarePlaywrightDriver
  }
  catch (error) {
    throw new BrowserProviderError("cloudflare", "load @cloudflare/playwright", { cause: error })
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
  return {
    features: {
      liveHandoff: true,
    },
    isolation: "provider",
    name: "cloudflare",
    async open(openOptions = {}) {
      const binding = typeof bindingOption === "string"
        ? await options.resolveBinding?.(bindingOption) ?? await runtimeBinding(bindingOption)
        : bindingOption
      if (!binding) {
        throw new BrowserProviderError("cloudflare", `resolve Browser Run binding ${JSON.stringify(bindingOption)}`)
      }
      const driver = options.driver || await loadDriver()
      let acquired: { sessionId: string }
      try {
        acquired = openOptions.idleTimeoutMs
          ? await driver.acquire(binding, { keep_alive: openOptions.idleTimeoutMs })
          : await driver.acquire(binding)
      }
      catch (error) {
        throw new BrowserProviderError("cloudflare", "acquire a Browser Run session", { cause: error })
      }
      let closed = false
      return {
        async close() {
          if (closed) return
          closed = true
          let browser: CloudflareBrowserHandle | undefined
          let cdp: Awaited<ReturnType<CloudflareBrowserHandle["newBrowserCDPSession"]>> | undefined
          try {
            const connected = await driver.connect(binding, acquired.sessionId)
            browser = connected
            cdp = await connected.newBrowserCDPSession()
            await cdp.send("Browser.close")
          }
          catch (error) {
            throw new BrowserProviderError("cloudflare", "terminate a Browser Run session", { cause: error })
          }
          finally {
            try {
              if (cdp) await cdp.detach()
            }
            catch {}
            try {
              if (browser) await browser.close()
            }
            catch {}
          }
        },
        connection: {
          binding,
          kind: "cloudflare-binding",
          sessionId: acquired.sessionId,
        },
        id: acquired.sessionId,
      }
    },
  }
}

export type { CloudflareBrowserBindingConnection } from "../internal/connections.ts"
