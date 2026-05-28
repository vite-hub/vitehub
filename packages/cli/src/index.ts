import { spawn } from "node:child_process"
import process from "node:process"

import { collectViteHubCliNamespaces } from "@vitehub/internal/cli"
import { resolve } from "pathe"

import type {
  ViteHubCliCommandNamespace,
  ViteHubCliContext,
  ViteHubCliSpawn,
  ViteHubCliSpawnOptions,
} from "@vitehub/internal/cli"
import type { InlineConfig, ResolvedConfig } from "vite"

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

function isHelp(args: string[]): boolean {
  return args.includes("-h") || args.includes("--help")
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

  if (!args.length || isHelp(args)) {
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
