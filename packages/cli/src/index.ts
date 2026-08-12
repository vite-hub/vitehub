#!/usr/bin/env node
import { spawn } from "node:child_process"
import { existsSync, realpathSync } from "node:fs"
import process from "node:process"
import { fileURLToPath } from "node:url"

import { collectViteHubCliNamespaces, collectViteHubProvisionSteps } from "@vite-hub/internal/cli"
import { resolve } from "pathe"

import { runProvision } from "./provision.ts"

import type { InlineConfig, ResolvedConfig } from "vite"
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
  stderr: { write: (chunk: string | Uint8Array) => unknown }
  stdout: { write: (chunk: string | Uint8Array) => unknown }
}

export interface RunViteHubCliOptions {
  args?: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  loadConfig?: (rootDir: string) => Promise<Pick<ResolvedConfig, "plugins" | "root">>
  loadNuxtViteConfig?: (rootDir: string) => Promise<{ plugins: readonly unknown[], root?: string } | undefined>
  spawn?: ViteHubCliSpawn
  stderr?: ViteHubCliStreams["stderr"]
  stdout?: ViteHubCliStreams["stdout"]
}

async function loadNuxtViteConfig(rootDir: string): Promise<{ plugins: readonly unknown[], root?: string } | undefined> {
  const hasNuxtConfig = ["nuxt.config.ts", "nuxt.config.js", "nuxt.config.mjs", "nuxt.config.cjs"]
    .some(file => existsSync(resolve(rootDir, file)))
  if (!hasNuxtConfig) return

  let loadNuxt: typeof import("nuxt/kit")["loadNuxt"]
  try {
    ({ loadNuxt } = await import("nuxt/kit"))
  }
  catch {
    throw new TypeError("[vitehub] Nuxt config was found, but Nuxt could not be loaded for CLI discovery.")
  }
  const nuxt = await loadNuxt({ cwd: rootDir, dev: false })
  try {
    const { resolveConfig } = await import("vite")
    const config = await resolveConfig({
      ...nuxt.options.vite,
      configFile: false,
      root: nuxt.options.rootDir || rootDir,
    }, "serve", "development")
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
      env: options.env,
      shell: process.platform === "win32",
      stdio: [
        "inherit",
        options.stdout || "inherit",
        options.stderr || "inherit",
      ],
    })
    child.on("error", reject)
    child.on("close", (exitCode, signal) => resolveResult({ exitCode, signal }))
  })
}

async function loadViteConfig(rootDir: string): Promise<Pick<ResolvedConfig, "plugins" | "root">> {
  const { resolveConfig } = await import("vite")
  const inlineConfig: InlineConfig = { root: rootDir }
  return await resolveConfig(inlineConfig, "serve", "development")
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
    ...namespace.features.map(feature => `  ${feature.name.padEnd(12)} ${feature.description || ""}`.trimEnd()),
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
  const nuxtConfig = options.loadConfig
    ? undefined
    : await (options.loadNuxtViteConfig || loadNuxtViteConfig)(cwd)
  const plugins = [...config.plugins, ...(nuxtConfig?.plugins ?? [])] as typeof config.plugins
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
  return typeof result === "number" ? result : 0
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
  runViteHubCli().then((exitCode) => {
    process.exit(exitCode)
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
