#!/usr/bin/env node
import { spawn } from "node:child_process"
import { existsSync, readFileSync, realpathSync } from "node:fs"
import process from "node:process"
import { fileURLToPath } from "node:url"

import { collectViteHubCliContribution, createCliDiscoveryNitroCloser, getStableStdoutWrite, withStdoutOnStderr } from "@vite-hub/internal/cli"
import { reservedOperationNamespaces } from "@vite-hub/internal/operations"
import { withViteStageEnvironment } from "@vite-hub/internal/vite-stage"
import { formatRuntimeDiagnosticError } from "@vite-hub/runtime"
import { resolve } from "pathe"

import { createInspectNamespace } from "./inspect.ts"
import { createOperationNamespaces, loadCliOperations, mergeOperationNamespaces } from "./operations.ts"
import { createProvisionNamespace } from "./provision.ts"
import { setupCommands } from "./setup/commands.ts"

import type { InlineConfig } from "vite"
import type { ViteHubCliCommand, ViteHubCliCommandNamespace, ViteHubCliContext } from "@vite-hub/internal/cli"
import type { HostCliRun } from "@vite-hub/internal/host-credentials"
import { cliErrorDiagnostics } from "./error-diagnostics.ts"

interface ViteHubCliSpawnResult {
  exitCode: number | null
  signal?: NodeJS.Signals | null
}

interface ViteHubCliSpawnOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  stderr?: "inherit" | "pipe"
  stdout?: "inherit" | "pipe" | "stderr"
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
  write: (chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => unknown
}

type ViteHubCliEntrypointStream =
  | { flush: () => unknown, write: (chunk: string | Uint8Array) => unknown }
  | { flush?: never, write: (chunk: string | Uint8Array) => void | PromiseLike<unknown> }

interface ViteHubCliLoadedConfig {
  plugins: readonly unknown[]
  root: string
  vitehubConfigResolved?: true
}

const BUILTIN_NAMESPACE_NAMES = new Set(reservedOperationNamespaces)

export interface RunViteHubCliOptions {
  args?: string[]
  /** Top-level commands that run before the project config loads, such as `vitehub status`. Defaults to the setup commands. */
  commands?: readonly ViteHubCliCommand[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Namespaces that run without loading the project config, for example inside a deployed container. */
  runtimeNamespaces?: ViteHubCliCommandNamespace[]
  /**
   * Features that run without loading the project config, for example commands that only talk to a server.
   * Other features of a project namespace with the same name still load the config.
   */
  runtimeFeatures?: ViteHubCliCommandNamespace[]
  /** Optional guard for runtime features that have a project-level opt-out. */
  runtimeFeatureGuard?: (namespace: string, feature: string, cwd: string) => boolean | Promise<boolean>
  /** Replaces `fetch` in commands that call a running app or a host API. */
  fetch?: typeof fetch
  /** Replaces the host CLI runner of setup commands, such as for `wrangler auth token`. */
  runHostCli?: HostCliRun
  loadConfig?: (rootDir: string, command: "build" | "serve", mode?: string) => Promise<ViteHubCliLoadedConfig>
  loadNuxtViteConfig?: (rootDir: string, command: "build" | "serve", mode?: string) => Promise<{ plugins: readonly unknown[], root?: string } | undefined>
  spawn?: ViteHubCliSpawn
  stderr?: ViteHubCliStreams["stderr"]
  stdout?: ViteHubCliStreams["stdout"]
}

export interface RunViteHubCliEntrypointOptions extends Omit<RunViteHubCliOptions, "stderr" | "stdout"> {
  stderr?: ViteHubCliEntrypointStream
  stdout?: ViteHubCliEntrypointStream
}

async function loadNuxtViteConfig(rootDir: string, command: "build" | "serve", mode?: string): Promise<{ plugins: readonly unknown[], root?: string } | undefined> {
  const hasNuxtConfig = ["nuxt.config.ts", "nuxt.config.mts", "nuxt.config.cts", "nuxt.config.js", "nuxt.config.mjs", "nuxt.config.cjs"]
    .some(file => existsSync(resolve(rootDir, file)))
  if (!hasNuxtConfig) return

  let loadNuxt: typeof import("nuxt/kit")["loadNuxt"]
  let loadNuxtConfig: typeof import("nuxt/kit")["loadNuxtConfig"]
  try {
    ({ loadNuxt, loadNuxtConfig } = await import("nuxt/kit"))
  }
  catch {
    throw cliErrorDiagnostics.CLI_R0001({ message: "[vitehub] Nuxt config was found, but Nuxt could not be loaded for CLI discovery." })
  }
  // SAFETY: vitehubCliDiscovery is an internal marker consumed by ViteHub's Nuxt module during config loading.
  const options = {
    cwd: rootDir,
    dev: command === "serve",
    ...(mode ? { envName: mode } : {}),
    overrides: { devtools: { enabled: false }, ...(mode ? { vite: { mode } } : {}), vitehubCliDiscovery: true },
    ready: true,
  } as Parameters<typeof loadNuxt>[0]
  if (mode) {
    // Read stage overrides before choosing the dotenv directory, then materialize module options under that env.
    const config = await loadNuxtConfig({ ...options, dotenv: false, overrides: { ...options.overrides, dev: options.dev } })
    const nuxtRoot = config.rootDir || rootDir
    const viteRoot = resolve(nuxtRoot, config.vite.root || nuxtRoot)
    const envDir = config.vite.envDir === false ? false : resolve(viteRoot, config.vite.envDir || ".")
    const { loadEnv } = await import("vite")
    Object.assign(process.env, loadEnv(mode, envDir, ""))
    options.dotenv = false
  }
  const nuxt = await loadNuxt(options)
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
    const config = await resolveConfig(inlineConfig, command, mode ?? (command === "build" ? "production" : "development"))
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
      // Windows needs a shell to run `.cmd` and `.bat` shims, including absolute paths. Node itself
      // runs without one, so a space in the executable path does not split the command.
      shell: process.platform === "win32" && command !== process.execPath,
      stdio: [
        "inherit",
        options.stdout === "stderr" ? process.stderr : options.stdout || "inherit",
        options.stderr || "inherit",
      ],
    })
    child.on("error", reject)
    child.on("close", (exitCode, signal) => resolveResult({ exitCode, signal }))
  })
}

async function loadViteConfig(rootDir: string, command: "build" | "serve", mode?: string): Promise<ViteHubCliLoadedConfig> {
  const { resolveConfig } = await import("vite")
  const inlineConfig: InlineConfig & { vitehubCliDiscovery: true } = {
    root: rootDir,
    ...(mode ? { mode } : {}),
    vitehubCliDiscovery: true,
  }
  const nitro = createCliDiscoveryNitroCloser()
  try {
    return await resolveConfig({ ...inlineConfig, plugins: [nitro.plugin] }, command, mode ?? (command === "build" ? "production" : "development"))
  }
  finally {
    await nitro.close()
  }
}

/** Keeps at least two spaces between a help name and its description. */
function helpNameWidth(names: readonly string[]): number {
  return Math.max(12, ...names.map(name => name.length + 1))
}

function writeRootHelp(namespaces: ViteHubCliCommandNamespace[], commands: readonly ViteHubCliCommand[], stdout: ViteHubCliContext["stdout"]): void {
  const width = helpNameWidth([...commands, ...namespaces].map(item => item.name))
  stdout.write([
    "Usage: vitehub <namespace> <feature> [args...]",
    "       vitehub <command> [args...]",
    "",
    ...(commands.length ? ["Project:", ...commands.map(command => `  ${command.name.padEnd(width)} ${command.description}`.trimEnd()), ""] : []),
    "Available namespaces:",
    ...namespaces.map(namespace => `  ${namespace.name.padEnd(width)} ${namespace.description || ""}`.trimEnd()),
    "",
  ].join("\n"))
}

function writeNamespaceHelp(namespace: ViteHubCliCommandNamespace, stdout: ViteHubCliContext["stdout"]): void {
  const width = helpNameWidth(namespace.features.map(feature => feature.name))
  stdout.write([
    `Usage: vitehub ${namespace.name} <feature> [args...]`,
    "",
    namespace.description || "",
    "",
    "Available features:",
    ...namespace.features.flatMap(feature => [
      `  ${feature.name.padEnd(width)} ${feature.description || ""}`.trimEnd(),
      ...(feature.usage ? [`    Usage: ${feature.usage}`] : []),
    ]),
    "",
  ].filter(Boolean).join("\n"))
}

function isRootHelp(args: string[]): boolean {
  return args[0] === "-h" || args[0] === "--help"
}

function readPackageVersion(): string {
  const manifest = readFileSync(new URL("../package.json", import.meta.url), "utf8")
  const version = /"version"\s*:\s*"([^"\\]+)"/u.exec(manifest)?.[1]
  if (!version) {
    throw cliErrorDiagnostics.CLI_R0002({ message: "[vitehub] The installed @vite-hub/cli package manifest has no valid version." })
  }
  return version
}

export async function runViteHubCli(options: RunViteHubCliOptions = {}): Promise<number> {
  const args = options.args || process.argv.slice(2)
  // Keep command writes on the stream writer captured before config loading.
  // Config loading temporarily patches process.stdout.write, and another CLI
  // invocation may own that patch when this command emits its payload.
  // SAFETY: The default Node stream is adapted to the narrower ViteHub stream contract, as in withStdoutOnStderr().
  const stdout: ViteHubCliStream = { write: options.stdout ? options.stdout.write.bind(options.stdout) : getStableStdoutWrite() as ViteHubCliStream["write"] }
  if (args[0] === "-v" || args[0] === "--version") {
    stdout.write(`${readPackageVersion()}\n`)
    return 0
  }

  const cwd = options.cwd || process.cwd()
  const env = options.env || process.env
  const stderr = options.stderr || ({
    write: (chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => typeof encoding === "function"
      ? process.stderr.write(chunk, encoding)
      : process.stderr.write(chunk, encoding, callback),
  } as ViteHubCliStreams["stderr"])
  const spawn = options.spawn || defaultSpawn
  const commands = options.commands ?? setupCommands
  // Setup commands never load the project config, so they work in an empty folder and on a config that throws.
  const setupCommand = commands.find(item => item.name === args[0])
  if (setupCommand) {
    return await setupCommand.run(args.slice(1), { cwd, env, ...(options.fetch ? { fetch: options.fetch } : {}), rootDir: cwd, ...(options.runHostCli ? { runHostCli: options.runHostCli } : {}), spawn, stderr, stdout })
  }
  const runtimeNamespace = options.runtimeNamespaces?.find(namespace => namespace.name === args[0] && !BUILTIN_NAMESPACE_NAMES.has(namespace.name))
  if (runtimeNamespace) return await runNamespace(runtimeNamespace, args, { cwd, env, rootDir: cwd, spawn, stderr, stdout })
  const runtimeFeatures = options.runtimeFeatures?.find(namespace => !BUILTIN_NAMESPACE_NAMES.has(namespace.name) && namespace.name === args[0] && namespace.features.some(feature => feature.name === args[1]))
  if (runtimeFeatures && (await options.runtimeFeatureGuard?.(args[0]!, args[1]!, cwd) ?? true)) {
    return await runNamespace(runtimeFeatures, args, { cwd, env, rootDir: cwd, spawn, stderr, stdout })
  }

  const command = args[0] === "inspect" && args[1] === "provider-output" ? "build" : "serve"
  // Channel definitions and their default public URL must use the same stage, including config-time loadEnv().
  const stageIndex = args[0] === "channels" && (args[1] === "sync" || args[1] === "history") ? args.lastIndexOf("--stage") : -1
  const stageValue = stageIndex === -1 ? undefined : args[stageIndex + 1]
  const stage = stageValue && !stageValue.startsWith("-") ? stageValue : undefined
  const loadProject = () => withStdoutOnStderr(async () => {
    const loadConfig = options.loadConfig || loadViteConfig
    const loadNuxtConfig = options.loadNuxtViteConfig || loadNuxtViteConfig
    const config = await (stage ? loadConfig(cwd, command, stage) : loadConfig(cwd, command))
    const nuxtConfig = config.vitehubConfigResolved
      ? undefined
      : await (stage ? loadNuxtConfig(cwd, command, stage) : loadNuxtConfig(cwd, command))
    const plugins = nuxtConfig?.plugins ?? config.plugins
    return {
      contribution: await collectViteHubCliContribution(plugins),
      operations: await loadCliOperations(plugins, stderr),
      plugins,
      rootDir: resolve(nuxtConfig?.root || config.root || cwd),
    }
  }, stderr)
  const { contribution, operations, plugins, rootDir } = await (stage ? withViteStageEnvironment(env, loadProject) : loadProject())
  const namespaces = [
    ...mergeOperationNamespaces(contribution.namespaces, createOperationNamespaces(operations)).filter(namespace => !BUILTIN_NAMESPACE_NAMES.has(namespace.name)),
    createInspectNamespace(plugins, operations),
    createProvisionNamespace(contribution.provision),
    ...(options.runtimeNamespaces ?? []).filter(namespace => !BUILTIN_NAMESPACE_NAMES.has(namespace.name)),
  ]

  const context: ViteHubCliContext = {
    cwd,
    env,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(contribution.publicUrl ? { publicUrl: contribution.publicUrl } : {}),
    rootDir,
    spawn,
    stderr,
    stdout,
  }

  if (!args.length || isRootHelp(args)) {
    writeRootHelp(namespaces, commands, stdout)
    return 0
  }

  const namespaceName = args[0]!
  const namespace = namespaces.find(item => item.name === namespaceName)
  if (!namespace) {
    stderr.write(`Unknown ViteHub CLI namespace: ${namespaceName}\n`)
    if (namespaces.length === 2 && namespaces.every(item => BUILTIN_NAMESPACE_NAMES.has(item.name))) {
      stderr.write(`No ViteHub integration contributed the "${namespaceName}" commands. Run this from a configured project and enable the matching integration in vite.config.ts or nuxt.config.ts.\n`)
    }
    writeRootHelp(namespaces, commands, stderr)
    return 1
  }

  return await runNamespace(namespace, args, context)
}

async function runNamespace(namespace: ViteHubCliCommandNamespace, args: string[], context: ViteHubCliContext): Promise<number> {
  const { stderr, stdout } = context
  const featureName = args[1]
  if (featureName === "-h" || featureName === "--help") {
    writeNamespaceHelp(namespace, stdout)
    return 0
  }
  // `vitehub usage` and `vitehub usage --json` run the default feature of the namespace.
  const defaultFeature = namespace.defaultFeature ? namespace.features.find(item => item.name === namespace.defaultFeature) : undefined
  if (defaultFeature && (!featureName || featureName.startsWith("-"))) return await defaultFeature.run(args.slice(1), context) ?? 0
  if (!featureName) {
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
      write(chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) {
        const result = Reflect.apply(stream.write, stream, [chunk, encoding, callback])
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
    write: ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
      if (typeof encoding === "function") return stream.write(chunk, encoding)
      return stream.write(chunk, encoding, callback)
    }) as ViteHubCliEntrypointStream["write"],
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
        stderr.stream.write(`${formatRuntimeDiagnosticError(error)}\n`)
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
