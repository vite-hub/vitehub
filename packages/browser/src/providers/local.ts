import { spawn } from "node:child_process"
import { existsSync, readdirSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

import { isPlainObject } from "@vite-hub/internal/object"
import { getViteHubErrorShape } from "@vite-hub/runtime"
import { browserProviderError } from "../errors.ts"

import type { BrowserDriver } from "../types.ts"
import type { CDPBrowserConnection } from "../internal/connections.ts"
import type { ChildProcess } from "node:child_process"
import { browserErrorDiagnostics } from "../error-diagnostics.ts"

export interface LocalBrowserOptions {
  args?: string[]
  env?: Record<string, string | undefined>
  /** The Chromium binary. Without it, the session finds one with `findChromiumExecutable()` when it opens. */
  executablePath?: string
  /**
   * Runs Chromium in its own sandbox. Defaults to `true`. Set `false` on a trusted host that blocks the sandbox, such as
   * Ubuntu 23.10+ without unprivileged user namespaces. A root process always runs without it, because Chromium refuses it.
   */
  sandbox?: boolean
  startupTimeout?: number
}

type Platform = "darwin" | "linux" | "win32"

const playwrightBinaries: Record<Platform, string[]> = {
  darwin: [
    "chrome-headless-shell-mac-arm64/chrome-headless-shell",
    "chrome-headless-shell-mac-x64/chrome-headless-shell",
    "chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium",
    "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
  ],
  linux: [
    "chrome-headless-shell-linux64/chrome-headless-shell",
    "chrome-linux/headless_shell",
    "chrome-linux64/chrome",
    "chrome-linux/chrome",
  ],
  win32: [
    "chrome-headless-shell-win64/chrome-headless-shell.exe",
    "chrome-win64/chrome.exe",
    "chrome-win/chrome.exe",
  ],
}

const systemBinaries: Record<Platform, string[]> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ],
  linux: [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/snap/bin/chromium",
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ],
}

function playwrightCache(env: Record<string, string | undefined>, platform: Platform): string {
  if (env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH !== "0") return env.PLAYWRIGHT_BROWSERS_PATH
  if (platform === "darwin") return join(homedir(), "Library", "Caches", "ms-playwright")
  if (platform === "win32") return join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "ms-playwright")
  return join(env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "ms-playwright")
}

function playwrightExecutable(env: Record<string, string | undefined>, platform: Platform): string | undefined {
  const cache = playwrightCache(env, platform)
  let entries: string[]
  try {
    entries = readdirSync(cache)
  }
  catch {
    return undefined
  }
  const revision = (name: string) => Number(name.slice(name.lastIndexOf("-") + 1)) || 0
  const installs = entries
    .filter(name => /^chromium(?:_headless_shell)?-\d+$/.test(name))
    .sort((left, right) => revision(right) - revision(left) || (left.includes("headless") ? -1 : 1))
  for (const install of installs) {
    if (!existsSync(join(cache, install, "INSTALLATION_COMPLETE"))) continue
    for (const binary of playwrightBinaries[platform]) {
      const path = join(cache, install, binary)
      if (existsSync(path)) return path
    }
  }
  return undefined
}

/**
 * Finds a Chromium for `localBrowser()`: `BROWSER_EXECUTABLE_PATH`, then the newest Chromium that Playwright installed,
 * then Chrome or Chromium in the usual system paths. Returns `undefined` when there is none.
 */
export function findChromiumExecutable(env: Record<string, string | undefined> = process.env): string | undefined {
  const configured = env.BROWSER_EXECUTABLE_PATH?.trim()
  if (configured) return configured
  const platform: Platform = process.platform === "darwin" || process.platform === "win32" ? process.platform : "linux"
  return playwrightExecutable(env, platform) ?? systemBinaries[platform].find(path => existsSync(path))
}

function resolveExecutable(options: LocalBrowserOptions): string {
  const executablePath = options.executablePath ?? findChromiumExecutable({ ...process.env, ...options.env })
  if (!executablePath) {
    throw browserErrorDiagnostics.BROWSER_CHROMIUM_NOT_FOUND({ message: "[vitehub:browser] Browser found no Chromium on this host. BROWSER_EXECUTABLE_PATH is not set, and no Playwright or system Chromium is installed." })
  }
  if (!existsSync(executablePath)) {
    throw browserErrorDiagnostics.BROWSER_CHROMIUM_NOT_FOUND({ message: `[vitehub:browser] The Chromium at ${JSON.stringify(executablePath)} does not exist.` })
  }
  return executablePath
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
        else if (port === undefined) reject(browserErrorDiagnostics.BROWSER_R0005({ message: "Failed to reserve a local browser port." }))
        else resolve(port)
      })
    })
  })
}

function chromiumRefusesSandboxAsRoot(): boolean {
  return process.getuid?.() === 0
}

function readStartupStderr(child: ChildProcess): { stop: () => void, text: () => string } {
  let output = ""
  const onData = (chunk: Buffer) => { output = `${output}${chunk.toString("utf8")}`.slice(-8_192) }
  child.stderr?.on("data", onData)
  return {
    stop() {
      child.stderr?.off("data", onData)
      child.stderr?.resume()
    },
    text: () => output,
  }
}

function exitError(child: ChildProcess, output: string) {
  if (output.includes("No usable sandbox")) {
    return browserErrorDiagnostics.BROWSER_CHROMIUM_SANDBOX_UNAVAILABLE()
  }
  return browserErrorDiagnostics.BROWSER_R0006({ message: `Chromium exited before its CDP endpoint was ready (${child.exitCode ?? child.signalCode}).` })
}

async function waitForEndpoint(port: number, child: ChildProcess, timeout: number): Promise<string> {
  const startupOutput = readStartupStderr(child)
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
          throw browserProviderError("local", "start Chromium", { cause: exitError(child, startupOutput.text()) })
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
    startupOutput.stop()
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

export function localBrowser(options: LocalBrowserOptions = {}): BrowserDriver<CDPBrowserConnection> {
  if (options?.executablePath !== undefined && (!options.executablePath || !isString(options.executablePath))) {
    throw browserErrorDiagnostics.BROWSER_R0007({ message: "[vitehub:browser] localBrowser() executablePath must be a non-empty string." })
  }
  const startupTimeout = options.startupTimeout ?? 15_000
  if (!Number.isFinite(startupTimeout) || startupTimeout <= 0 || startupTimeout > 2_147_483_647) {
    throw browserErrorDiagnostics.BROWSER_R0008({ message: "[vitehub:browser] localBrowser() startupTimeout must be greater than zero and no greater than 2147483647ms." })
  }
  return {
    features: {
      liveHandoff: true,
    },
    isolation: "trusted-host",
    name: "local",
    async open(openOptions = {}) {
      if (openOptions.idleTimeoutMs !== undefined) {
        throw browserProviderError("local", "configure an idle timeout for a local Chromium")
      }
      const executablePath = resolveExecutable(options)
      let profile: string | undefined
      let child: ChildProcess | undefined
      try {
        const port = await openPort()
        profile = await mkdtemp(join(tmpdir(), "vitehub-browser-"))
        child = spawn(executablePath, [
          "--headless=new",
          "--disable-background-networking",
          "--disable-default-apps",
          "--disable-extensions",
          "--disable-sync",
          "--no-first-run",
          `--remote-debugging-port=${port}`,
          `--user-data-dir=${profile}`,
          ...(options.sandbox === false || chromiumRefusesSandboxAsRoot() ? ["--no-sandbox"] : []),
          "about:blank",
          ...(options.args || []),
        ], {
          env: { ...process.env, ...options.env },
          stdio: ["ignore", "ignore", "pipe"],
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
