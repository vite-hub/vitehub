import { hasRuntimeType } from "@vite-hub/runtime/internal/runtime-type"

import { browserProviderError } from "../errors.ts"
import { cloudflareBrowserTerminated } from "./connections.ts"

import type { BrowserEngine, BrowserProvider } from "../types.ts"
import type { CloudflareBrowserBindingConnection } from "./connections.ts"

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

export type LoadCloudflarePlaywright = () => Promise<CloudflarePlaywrightDriver>

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

export function createCloudflareBrowser(
  options: CloudflareBrowserOptions,
  loadCloudflarePlaywright: LoadCloudflarePlaywright,
): BrowserProvider<CloudflareBrowserBindingConnection> {
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
      const driver = options.driver || await loadCloudflarePlaywright()
      let acquired: { sessionId: string }
      try {
        acquired = openOptions.idleTimeoutMs
          ? await driver.acquire(binding, { keep_alive: openOptions.idleTimeoutMs })
          : await driver.acquire(binding)
        if (!acquired || !isCloudflareSessionId(acquired.sessionId)) {
          throw new TypeError("Cloudflare Browser Run returned an invalid session id.")
        }
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

function isCloudflareSessionId(value: unknown): value is string {
  return hasRuntimeType(value, "string")
    && value.length > 0
    && isWellFormedUnicode(value)
    && value !== "."
    && value !== ".."
    && !/[\\/?#%\s\p{Cc}]/u.test(value)
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return false
      index++
    }
    else if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) {
      return false
    }
  }
  return true
}

export type { CloudflareBrowserBindingConnection } from "../internal/connections.ts"
