import { spawn } from "node:child_process"
import process from "node:process"

import { resolve } from "pathe"

import type { InlineConfig, ResolvedConfig } from "vite"

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

interface ViteHubCliContext {
  cwd: string
  env: NodeJS.ProcessEnv
  rootDir: string
  spawn: ViteHubCliSpawn
  stderr: { write: (chunk: string | Uint8Array) => unknown }
  stdout: { write: (chunk: string | Uint8Array) => unknown }
}

interface ViteHubCliFeature {
  description?: string
  name: string
  run: (args: string[], context: ViteHubCliContext) => Promise<number | void> | number | void
  usage?: string
}

interface ViteHubCliCommandNamespace {
  description?: string
  features: ViteHubCliFeature[]
  name: string
}

interface ViteHubCliContributor {
  namespaces: ViteHubCliCommandNamespace[]
}

type ViteHubCliContributorFactory = () => ViteHubCliContributor | undefined | Promise<ViteHubCliContributor | undefined>

interface ViteHubCliPluginMetadata {
  cli?: ViteHubCliContributor | ViteHubCliContributorFactory
}

interface ViteHubCliContributingPlugin {
  vitehub?: ViteHubCliPluginMetadata
}

export interface RunViteHubCliOptions {
  args?: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  loadConfig?: (rootDir: string) => Promise<Pick<ResolvedConfig, "plugins" | "root">>
  spawn?: ViteHubCliSpawn
  stderr?: ViteHubCliContext["stderr"]
  stdout?: ViteHubCliContext["stdout"]
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

async function resolveContributor(value: ViteHubCliPluginMetadata["cli"]): Promise<ViteHubCliContributor | undefined> {
  return typeof value === "function" ? await value() : value
}

async function collectViteHubCliNamespaces(plugins: readonly unknown[]): Promise<ViteHubCliCommandNamespace[]> {
  const namespaces = new Map<string, ViteHubCliCommandNamespace>()

  for (const plugin of plugins) {
    if (!plugin || typeof plugin !== "object") continue
    const metadata = (plugin as ViteHubCliContributingPlugin).vitehub
    const contributor = await resolveContributor(metadata?.cli)
    if (!contributor) continue

    for (const namespace of contributor.namespaces) {
      const existing = namespaces.get(namespace.name)
      if (!existing) {
        namespaces.set(namespace.name, { ...namespace, features: [...namespace.features] })
        continue
      }

      const features = new Map(existing.features.map(feature => [feature.name, feature]))
      for (const feature of namespace.features) {
        features.set(feature.name, feature)
      }
      existing.features = [...features.values()]
    }
  }

  return [...namespaces.values()]
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
  const rootDir = resolve(config.root || cwd)
  const namespaces = await collectViteHubCliNamespaces(config.plugins)

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

if (import.meta.url === `file://${process.argv[1]}`) {
  runViteHubCli().then((exitCode) => {
    process.exitCode = exitCode
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
