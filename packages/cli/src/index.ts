#!/usr/bin/env node
import { spawn } from "node:child_process"
import { existsSync, realpathSync } from "node:fs"
import { constants } from "node:os"
import process from "node:process"
import { fileURLToPath } from "node:url"

import { collectViteHubCliNamespaces, collectViteHubProvisionSteps } from "@vite-hub/internal/cli"
import { resolve } from "pathe"

import { runProvision } from "./provision.ts"

import type { InlineConfig } from "vite"
import type { ViteHubCliCommandNamespace, ViteHubCliContext } from "@vite-hub/internal/cli"

interface ViteHubCliSpawnResult {
  exitCode: number | null
  signal?: NodeJS.Signals | null
}

interface ViteHubCliSpawnOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  stderr?: "inherit" | "pipe"
  stdout?: "inherit" | "pipe"
}

type ViteHubCliSpawn = (
  command: string,
  args: string[],
  options?: ViteHubCliSpawnOptions,
) => Promise<ViteHubCliSpawnResult>

interface ViteHubCliStreams {
  stderr: ViteHubCliStream
  stdout: ViteHubCliStream
}

interface ViteHubCliStream {
  flush?: () => unknown
  write: (chunk: string | Uint8Array) => unknown
}

type ViteHubCliEntrypointStream =
  | { flush: () => unknown, write: (chunk: string | Uint8Array) => unknown }
  | { flush?: never, write: (chunk: string | Uint8Array) => void | PromiseLike<unknown> }

interface ViteHubCliLoadedConfig {
  plugins: readonly unknown[]
  root: string
  vitehubConfigResolved?: true
}

export interface RunViteHubCliOptions {
  args?: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  loadConfig?: (rootDir: string) => Promise<ViteHubCliLoadedConfig>
  loadNuxtViteConfig?: (rootDir: string) => Promise<{ plugins: readonly unknown[], root?: string } | undefined>
  spawn?: ViteHubCliSpawn
  stderr?: ViteHubCliStreams["stderr"]
  stdout?: ViteHubCliStreams["stdout"]
}

export interface RunViteHubCliEntrypointOptions extends Omit<RunViteHubCliOptions, "stderr" | "stdout"> {
  stderr?: ViteHubCliEntrypointStream
  stdout?: ViteHubCliEntrypointStream
}

async function loadNuxtViteConfig(rootDir: string): Promise<{ plugins: readonly unknown[], root?: string } | undefined> {
  const hasNuxtConfig = ["nuxt.config.ts", "nuxt.config.mts", "nuxt.config.cts", "nuxt.config.js", "nuxt.config.mjs", "nuxt.config.cjs"]
    .some(file => existsSync(resolve(rootDir, file)))
  if (!hasNuxtConfig) return

  let loadNuxt: typeof import("nuxt/kit")["loadNuxt"]
  try {
    ({ loadNuxt } = await import("nuxt/kit"))
  }
  catch {
    throw new TypeError("[vitehub] Nuxt config was found, but Nuxt could not be loaded for CLI discovery.")
  }
  // SAFETY: vitehubCliDiscovery is an internal marker consumed by ViteHub's Nuxt module during config loading.
  const nuxt = await loadNuxt({
    cwd: rootDir,
    dev: false,
    overrides: { vitehubCliDiscovery: true },
  } as Parameters<typeof loadNuxt>[0])
  try {
    const { resolveConfig } = await import("vite")
    const viteRoot = nuxt.options.vite.root
    const inlineConfig: InlineConfig & { vitehubCliDiscovery: true } = {
      ...nuxt.options.vite,
      configFile: false,
      root: viteRoot
        ? resolve(nuxt.options.rootDir || rootDir, viteRoot)
        : nuxt.options.rootDir || rootDir,
      vitehubCliDiscovery: true,
    }
    const config = await resolveConfig(inlineConfig, "serve", "development")
    return {
      plugins: config.plugins,
      root: config.root,
    }
  }
  finally {
    await nuxt.close()
  }
}

function defaultSpawn(command: string, args: string[], options: ViteHubCliSpawnOptions = {}) {
  return new Promise<{ exitCode: number | null, signal: NodeJS.Signals | null }>((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      env: options.env,
      shell: process.platform === "win32",
      stdio: [
        "inherit",
        options.stdout || "inherit",
        options.stderr || "inherit",
      ],
    })
    const forwardedSignals = process.platform === "win32"
      ? []
      : ["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM"] as const
    const handlers = new Map<NodeJS.Signals, () => void>()
    const cleanup = () => {
      for (const [signal, handler] of handlers) process.off(signal, handler)
    }
    for (const signal of forwardedSignals) {
      const handler = () => {
        if (!child.pid) child.kill(signal)
        else {
          try {
            process.kill(-child.pid, signal)
          }
          catch (error) {
            if (Reflect.get(Object(error), "code") !== "ESRCH") throw error
          }
        }
      }
      handlers.set(signal, handler)
      process.on(signal, handler)
    }
    child.on("error", (error) => {
      cleanup()
      reject(error)
    })
    child.on("close", (exitCode, signal) => {
      cleanup()
      resolveResult({
        exitCode: exitCode ?? (signal ? 128 + constants.signals[signal] : null),
        signal,
      })
    })
  })
}

async function loadViteConfig(rootDir: string): Promise<ViteHubCliLoadedConfig> {
  const { resolveConfig } = await import("vite")
  const inlineConfig: InlineConfig & { vitehubCliDiscovery: true } = {
    root: rootDir,
    vitehubCliDiscovery: true,
  }
  return await resolveConfig(inlineConfig, "serve", "development")
}

function hasViteConfig(rootDir: string) {
  return ["vite.config.ts", "vite.config.mts", "vite.config.cts", "vite.config.js", "vite.config.mjs", "vite.config.cjs"]
    .some(file => existsSync(resolve(rootDir, file)))
}

// Built-in namespace that orchestrates package-contributed Provision Steps.
function createProvisionNamespace(plugins: readonly unknown[]): ViteHubCliCommandNamespace {
  const collectSteps = () => collectViteHubProvisionSteps(plugins)
  const run = (args: string[], context: ViteHubCliContext) => runProvision(args, context, { collectSteps })
  return {
    description: "Idempotently create missing provider resources.",
    features: [{
      description: "Create missing provider resources for the app's Definitions.",
      name: "run",
      run,
      usage: "vitehub provision run --provider <cloudflare|vercel> [--dry-run]",
    }],
    name: "provision",
  }
}

function writeRootHelp(namespaces: ViteHubCliCommandNamespace[], stdout: ViteHubCliContext["stdout"]): void {
  stdout.write([
    "Usage: vitehub <namespace> <feature> [args...]",
    "",
    "Available namespaces:",
    ...namespaces.map(namespace => `  ${namespace.name.padEnd(12)} ${namespace.description || ""}`.trimEnd()),
    "",
  ].join("\n"))
}

function writeNamespaceHelp(namespace: ViteHubCliCommandNamespace, stdout: ViteHubCliContext["stdout"]): void {
  stdout.write([
    `Usage: vitehub ${namespace.name} <feature> [args...]`,
    "",
    namespace.description || "",
    "",
    "Available features:",
    ...namespace.features.flatMap(feature => [
      `  ${feature.name.padEnd(12)} ${feature.description || ""}`.trimEnd(),
      ...(feature.usage ? [`    Usage: ${feature.usage}`] : []),
    ]),
    "",
  ].filter(Boolean).join("\n"))
}

function isRootHelp(args: string[]): boolean {
  return args[0] === "-h" || args[0] === "--help"
}

export async function runViteHubCli(options: RunViteHubCliOptions = {}): Promise<number> {
  const args = options.args || process.argv.slice(2)
  const cwd = options.cwd || process.cwd()
  const env = options.env || process.env
  const stdout = options.stdout || process.stdout
  const stderr = options.stderr || process.stderr
  const config = await (options.loadConfig || loadViteConfig)(cwd)
  const nuxtConfig = config.vitehubConfigResolved || (!options.loadConfig && hasViteConfig(cwd))
    ? undefined
    : await (options.loadNuxtViteConfig || loadNuxtViteConfig)(cwd)
  const plugins = [...config.plugins, ...(nuxtConfig?.plugins ?? [])]
  const rootDir = resolve(nuxtConfig?.root || config.root || cwd)
  const namespaces = [
    ...await collectViteHubCliNamespaces(plugins),
    createProvisionNamespace(plugins),
  ]

  const context: ViteHubCliContext = {
    cwd,
    env,
    rootDir,
    spawn: options.spawn || defaultSpawn,
    stderr,
    stdout,
  }

  if (!args.length || isRootHelp(args)) {
    writeRootHelp(namespaces, stdout)
    return 0
  }

  const namespaceName = args[0]!
  const namespace = namespaces.find(item => item.name === namespaceName)
  if (!namespace) {
    stderr.write(`Unknown ViteHub CLI namespace: ${namespaceName}\n`)
    writeRootHelp(namespaces, stderr)
    return 1
  }

  const featureName = args[1]
  if (!featureName || args[1] === "-h" || args[1] === "--help") {
    writeNamespaceHelp(namespace, stdout)
    return 0
  }

  const feature = namespace.features.find(item => item.name === featureName)
  if (!feature) {
    stderr.write(`Unknown ViteHub CLI feature: ${namespace.name} ${featureName}\n`)
    writeNamespaceHelp(namespace, stderr)
    return 1
  }

  const result = await feature.run(args.slice(2), context)
  return result ?? 0
}

function trackStream(stream: ViteHubCliStream) {
  const writes: Array<Promise<PromiseSettledResult<unknown>>> = []
  return {
    stream: {
      write(chunk: string | Uint8Array) {
        const result = stream.write(chunk)
        writes.push(Promise.resolve(result).then<PromiseSettledResult<unknown>, PromiseSettledResult<unknown>>(
          value => ({ status: "fulfilled", value }),
          reason => ({ reason, status: "rejected" }),
        ))
        return result
      },
    },
    async flush() {
      const results = await Promise.all(writes)
      let flushFailure: { reason: unknown } | undefined
      try {
        if (stream.flush) {
          await stream.flush()
        }
      }
      catch (error: unknown) {
        flushFailure = { reason: error }
      }
      const rejected = results.find(result => result.status === "rejected")
      if (rejected) {
        throw rejected.reason
      }
      if (flushFailure) {
        throw flushFailure.reason
      }
    },
  }
}

function processEntrypointStream(stream: NodeJS.WriteStream): ViteHubCliEntrypointStream {
  return {
    flush: () => new Promise<void>((resolveFlush, rejectFlush) => stream.write("", (error) => {
      if (error) {
        rejectFlush(error)
      }
      else {
        resolveFlush()
      }
    })),
    write: chunk => stream.write(chunk),
  }
}

export function runViteHubCliEntrypoint(options: RunViteHubCliEntrypointOptions = {}): void {
  const stderr = trackStream(options.stderr || processEntrypointStream(process.stderr))
  const stdout = trackStream(options.stdout || processEntrypointStream(process.stdout))
  void (async () => {
    let exitCode: number
    try {
      exitCode = await runViteHubCli({ ...options, stderr: stderr.stream, stdout: stdout.stream })
    }
    catch (error: unknown) {
      try {
        stderr.stream.write(`${error instanceof Error ? error.message : error}\n`)
      }
      catch {}
      exitCode = 1
    }
    const flushes = await Promise.allSettled([stdout.flush(), stderr.flush()])
    if (flushes.some(result => result.status === "rejected")) {
      exitCode = 1
    }
    process.exit(exitCode)
  })()
}

function isCliEntrypoint() {
  if (!process.argv[1]) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
  }
  catch {
    return false
  }
}

if (isCliEntrypoint()) {
  runViteHubCliEntrypoint()
}
