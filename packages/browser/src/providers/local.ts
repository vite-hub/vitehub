import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { isPlainObject } from "@vite-hub/internal/object"
import { getViteHubErrorShape } from "@vite-hub/runtime"
import { browserProviderError } from "../errors.ts"

import type { BrowserProvider } from "../types.ts"
import type { CDPBrowserConnection } from "../internal/connections.ts"
import type { ChildProcess } from "node:child_process"

export interface LocalBrowserOptions {
  args?: string[]
  env?: Record<string, string | undefined>
  executablePath: string
  startupTimeout?: number
}

function isString(value: unknown): value is string {
  try {
    return String(value) === value
  }
  catch {
    return false
  }
}

function isNumber(value: unknown): value is number {
  try {
    return Number(value) === value
  }
  catch {
    return false
  }
}

async function openPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = isPlainObject(address) && isNumber(address.port) ? address.port : undefined
      server.close((error) => {
        if (error) reject(error)
        else if (port === undefined) reject(new Error("Failed to reserve a local browser port."))
        else resolve(port)
      })
    })
  })
}

async function waitForEndpoint(port: number, child: ChildProcess, timeout: number): Promise<string> {
  let rejectSpawn!: (error: unknown) => void
  let timer: ReturnType<typeof setTimeout> | undefined
  const spawnError = new Promise<never>((_resolve, reject) => { rejectSpawn = reject })
  const onError = (error: Error) => rejectSpawn(error)
  const controller = new AbortController()
  child.once("error", onError)
  try {
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(browserProviderError("local", "start Chromium"))
      }, timeout)
    })
    return await Promise.race([spawnError, timedOut, (async () => {
      const startedAt = Date.now()
      let lastError: unknown
      while (Date.now() - startedAt < timeout) {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw browserProviderError("local", "start Chromium", {
            cause: new Error(`Chromium exited before its CDP endpoint was ready (${child.exitCode ?? child.signalCode}).`),
          })
        }
        try {
          const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
            signal: controller.signal,
          })
          if (response.ok) {
            const value: unknown = await response.json()
            if (isPlainObject(value) && isString(value.webSocketDebuggerUrl)) return value.webSocketDebuggerUrl
          }
        }
        catch (error) {
          lastError = error
        }
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      throw browserProviderError("local", "start Chromium", { cause: lastError })
    })()])
  }
  finally {
    controller.abort()
    if (timer) clearTimeout(timer)
    child.off("error", onError)
  }
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()))
  child.kill("SIGTERM")
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise<false>(resolve => setTimeout(() => resolve(false), 2_000)),
  ])
  if (!stopped && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL")
    await exited
  }
}

export function localBrowser(options: LocalBrowserOptions): BrowserProvider<CDPBrowserConnection> {
  if (!options?.executablePath || !isString(options.executablePath)) {
    throw new TypeError("[vitehub:browser] localBrowser() requires an executablePath.")
  }
  const startupTimeout = options.startupTimeout ?? 15_000
  if (!Number.isFinite(startupTimeout) || startupTimeout <= 0 || startupTimeout > 2_147_483_647) {
    throw new TypeError("[vitehub:browser] localBrowser() startupTimeout must be greater than zero and no greater than 2147483647ms.")
  }
  return {
    features: {
      liveHandoff: true,
    },
    isolation: "trusted-host",
    name: "local",
    async open() {
      let profile: string | undefined
      let child: ChildProcess | undefined
      try {
        const port = await openPort()
        profile = await mkdtemp(join(tmpdir(), "vitehub-browser-"))
        child = spawn(options.executablePath, [
          "--headless=new",
          "--disable-background-networking",
          "--disable-default-apps",
          "--disable-extensions",
          "--disable-sync",
          "--no-first-run",
          `--remote-debugging-port=${port}`,
          `--user-data-dir=${profile}`,
          "about:blank",
          ...(options.args || []),
        ], {
          env: { ...process.env, ...options.env },
          stdio: "ignore",
        })
        const endpoint = await waitForEndpoint(port, child, startupTimeout)
        let closed = false
        return {
          async close() {
            if (closed) return
            closed = true
            try {
              await stopProcess(child!)
            }
            finally {
              await rm(profile!, { force: true, recursive: true })
            }
          },
          connection: { endpoint, kind: "cdp" },
          id: `local:${child.pid ?? "unknown"}`,
        }
      }
      catch (error) {
        if (child) await stopProcess(child).catch(() => {})
        if (profile) await rm(profile, { force: true, recursive: true }).catch(() => {})
        if (getViteHubErrorShape(error)?.code === "BROWSER_PROVIDER_ERROR") throw error
        throw browserProviderError("local", "start Chromium", { cause: error })
      }
    },
  }
}

export type { CDPBrowserConnection } from "../internal/connections.ts"
