import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { BrowserProviderError } from "../errors.ts"

import type { BrowserProvider } from "../types.ts"
import type { CDPBrowserConnection } from "../internal/connections.ts"
import type { ChildProcess } from "node:child_process"

export interface LocalBrowserOptions {
  args?: string[]
  env?: Record<string, string | undefined>
  executablePath: string
  startupTimeout?: number
}

async function openPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : undefined
      server.close(error => error ? reject(error) : resolve(port!))
    })
  })
}

async function waitForEndpoint(port: number, child: ChildProcess, timeout: number): Promise<string> {
  const startedAt = Date.now()
  let lastError: unknown
  while (Date.now() - startedAt < timeout) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new BrowserProviderError("local", "start Chromium", {
        cause: new Error(`Chromium exited before its CDP endpoint was ready (${child.exitCode ?? child.signalCode}).`),
      })
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) {
        const value = await response.json() as { webSocketDebuggerUrl?: unknown }
        if (typeof value.webSocketDebuggerUrl === "string") return value.webSocketDebuggerUrl
      }
    }
    catch (error) {
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new BrowserProviderError("local", "start Chromium", { cause: lastError })
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
  if (!options?.executablePath || typeof options.executablePath !== "string") {
    throw new TypeError("[vitehub:browser] localBrowser() requires an executablePath.")
  }
  const startupTimeout = options.startupTimeout ?? 15_000
  return {
    features: {
      artifacts: false,
      liveHandoff: true,
      stateExport: false,
      stateImport: false,
    },
    isolation: "trusted-host",
    name: "local",
    async open() {
      const port = await openPort()
      const profile = await mkdtemp(join(tmpdir(), "vitehub-browser-"))
      let child: ChildProcess | undefined
      try {
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
              await rm(profile, { force: true, recursive: true })
            }
          },
          connection: { endpoint, kind: "cdp" },
          id: `local:${child.pid ?? "unknown"}`,
        }
      }
      catch (error) {
        if (child) await stopProcess(child).catch(() => {})
        await rm(profile, { force: true, recursive: true }).catch(() => {})
        if (error instanceof BrowserProviderError) throw error
        throw new BrowserProviderError("local", "start Chromium", { cause: error })
      }
    },
  }
}

export type { CDPBrowserConnection } from "../internal/connections.ts"
