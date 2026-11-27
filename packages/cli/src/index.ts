import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import process from "node:process"

import { collectViteHubCliContribution, createCliDiscoveryNitroCloser, getStableStdoutWrite, viteCliProjectConfig, withStdoutOnStderr } from "@vite-hub/internal/cli"
import { quoteSupportedInstallSpecifier } from "@vite-hub/internal/features"
import { reservedOperationNamespaces, setupCommandNames } from "@vite-hub/internal/operations"
import { loadAllEnv, withViteStageEnvironment } from "@vite-hub/internal/vite-stage"
import { formatRuntimeDiagnosticError } from "@vite-hub/runtime"
import { resolve } from "pathe"

import { drainCommand } from "./drain.ts"
import { createInspectNamespace } from "./inspect.ts"
import { createOperationNamespaces, loadCliOperations, mergeOperationNamespaces } from "./operations.ts"
import { createProvisionNamespace } from "./provision.ts"
import { renamedCommandMessage } from "./renamed-commands.ts"
import { createSeedNamespace } from "./seed.ts"

import type { LoadProvision } from "./provision.ts"
import type { InlineConfig } from "vite"
import type { ViteHubCliCommand, ViteHubCliCommandNamespace, ViteHubCliContext, ViteHubCliProvision } from "@vite-hub/internal/cli"
import type { HostCliRun } from "@vite-hub/internal/host-credentials"
import type { ProvisionProvider } from "@vite-hub/internal/provision"
import { cliErrorDiagnostics } from "./error-diagnostics.ts"

interface ViteHubCliSpawnResult {
  exitCode: number | null
  signal?: NodeJS.Signals | null
  stdout?: string
}

interface ViteHubCliSpawnOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  stderr?: "inherit" | "pipe"
  stdin?: "ignore" | "inherit"
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
  nitro?: unknown
  plugins: readonly unknown[]
  root: string
  vitehubConfigResolved?: true
}

const BUILTIN_NAMESPACE_NAMES = new Set(reservedOperationNamespaces)
const ROOT_HELP_WITHOUT_CONFIG = "[vitehub] The project config did not load. Project namespaces are missing. Of the commands below, only `deploy`, `provision run`, and `provision status` load the config. Fix the error above to use those three commands and the project namespaces."
const ENV_HELP_WITHOUT_CONFIG = "[vitehub] The project config did not load. The list below shows only the env commands that do not load the config. Fix the error above to see the project env commands."

const hostEnvFeatures: ViteHubCliCommandNamespace = {
  description: "Compare, push, and pull the env names of the app on a host.",
  features: [
    {
      description: "Compare the env names of the last build with the names on the linked host. Exits with 1 when a required name is missing. Never reads values.",
      name: "diff",
      run: async (args, context) => await (await import("./setup/env.ts")).runEnvCommand({ ...hostEnvFeatures.features[0]!, name: "diff" }, args, context),
      usage: "vitehub env diff [--host <host>] [--to github [--repo <owner/name>] [--environment <name>]] [--stage <name>] [--json]",
    },
    {
      description: "Set the host variables of the build's env names from the shell and .env.<stage>, with the host CLI. Prints names, never values. Never deletes a host variable.",
      name: "push",
      run: async (args, context) => await (await import("./setup/env.ts")).runEnvCommand({ ...hostEnvFeatures.features[1]!, name: "push" }, args, context),
      usage: "vitehub env push [--host <host>] [--to github [--repo <owner/name>] [--environment <name>]] [--stage <name>] [--only <NAME>]... [--yes] [--json]",
    },
    {
      description: "Write the env values of a stage from a self-hosted Console to .env.<stage>. Needs `vitehub login` and the owner or admin role.",
      name: "pull",
      run: async (args, context) => await (await import("./setup/console-env.ts")).envPullFeature.run(args, context),
      usage: "vitehub env pull --from console [--stage <name>] [--project <id>] [--console <url>] [--yes] [--json]",
    },
  ],
  name: "env",
}

async function loadSetupCommands(): Promise<readonly ViteHubCliCommand[]> {
  return (await import("./setup/commands.ts")).setupCommands
}

export interface RunViteHubCliOptions {
  args?: string[]
  /** Top-level commands that run before the project config loads, such as `vitehub status`. Defaults to the setup commands and `drain`. */
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
  /**
   * Project namespaces whose help needs no project, by name. `vitehub <namespace> --help` and
   * `vitehub <namespace> <feature> --help` answer from them without loading the config, which takes seconds in a Nuxt
   * app. Every feature of such a namespace must print its help for `-h` or `--help` before it reads the project.
   */
  helpNamespaces?: Record<string, () => Promise<ViteHubCliCommandNamespace | undefined>>
  /** Optional guard for runtime features that have a project-level opt-out. */
  runtimeFeatureGuard?: (namespace: string, feature: string, cwd: string) => boolean | Promise<boolean>
  /** Replaces `fetch` in commands that call a running app or a host API. */
  fetch?: typeof fetch
  /** Replaces the host CLI runner of setup and provision commands, such as for `wrangler auth token`. */
  runHostCli?: HostCliRun
  /** Replaces how `vitehub deploy` loads the Provision Steps of the project config for a host. */
  loadProvision?: (host: ProvisionProvider) => Promise<ViteHubCliProvision>
  loadConfig?: (rootDir: string, command: "build" | "serve", mode?: string) => Promise<ViteHubCliLoadedConfig>
  loadNuxtViteConfig?: (rootDir: string, command: "build" | "serve", mode?: string) => Promise<{ nitro?: unknown, plugins: readonly unknown[], root?: string } | undefined>
  spawn?: ViteHubCliSpawn
  stderr?: ViteHubCliStreams["stderr"]
  stdout?: ViteHubCliStreams["stdout"]
}

export interface RunViteHubCliEntrypointOptions extends Omit<RunViteHubCliOptions, "stderr" | "stdout"> {
  stderr?: ViteHubCliEntrypointStream
  stdout?: ViteHubCliEntrypointStream
}

async function loadNuxtViteConfig(rootDir: string, command: "build" | "serve", mode?: string): Promise<{ nitro?: unknown, plugins: readonly unknown[], root?: string } | undefined> {
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
    envName: mode ?? (command === "build" ? "production" : "development"),
    overrides: { devtools: { enabled: false }, ...(mode ? { vite: { mode } } : {}), vitehubCliDiscovery: true },
    ready: true,
  } as Parameters<typeof loadNuxt>[0]
  if (mode) {
    const config = await loadNuxtConfig({ ...options, dotenv: false, overrides: { ...options.overrides, dev: options.dev } })
    const nuxtRoot = config.rootDir || rootDir
    const viteRoot = resolve(nuxtRoot, config.vite.root || nuxtRoot)
    const envDir = config.vite.envDir === false ? false : resolve(viteRoot, config.vite.envDir || ".")
    const { loadEnv } = await import("vite")
    Object.assign(process.env, loadAllEnv(loadEnv, mode, envDir))
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
      nitro: { handlers: [
        ...resolveRouteHandlers({
          ...Object(Reflect.get(config, "nitro")),
          alias: { ...nuxt.options.alias, ...Reflect.get(nuxt.options.nitro, "alias"), ...Reflect.get(Object(Reflect.get(config, "nitro")), "alias") },
        }, config.root),
        ...resolveRouteHandlers({
          ...nuxt.options.nitro,
          alias: { ...nuxt.options.alias, ...Reflect.get(nuxt.options.nitro, "alias") },
          handlers: [...nitroHandlers(nuxt.options.nitro), ...nuxt.options.serverHandlers],
        }, nuxt.options.rootDir || rootDir),
      ] },
      plugins: config.plugins,
      root: config.root,
    }
  }
  finally {
    await nuxt.close()
  }
}

function nitroHandlers(nitro: unknown): unknown[] {
  const handlers: unknown = Reflect.get(Object(nitro), "handlers")
  return Array.isArray(handlers) ? handlers : []
}

function resolveRouteHandlers(nitro: unknown, projectRoot: string): unknown[] {
  const options = Object(nitro)
  const rootDir = resolve(projectRoot, Reflect.get(options, "rootDir") || ".")
  const pathOptions = {
    ...options,
    rootDir,
    buildDir: resolve(rootDir, Reflect.get(options, "buildDir") || "."),
  }
  const aliases = Object.entries(Reflect.get(options, "alias") || {})
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .sort(([a], [b]) => b.length - a.length)
  return nitroHandlers(nitro).map((entry) => {
    const handler: unknown = Reflect.get(Object(entry), "handler")
    if (typeof handler !== "string") return entry
    let file = handler.replace(/{{ ?([\w.]+) ?}}/g, (_, key: string) => {
      const value = key.split(".").reduce<unknown>((object, part) => Reflect.get(Object(object), part), pathOptions)
      return value ? String(value) : key
    })
    const visited = new Set<string>()
    while (true) {
      const alias = aliases.find(([key]) => file === key || file.startsWith(`${key}/`))
      if (!alias || visited.has(alias[0])) break
      visited.add(alias[0])
      file = alias[1] + file.slice(alias[0].length)
    }
    return { ...Object(entry), handler: /^[#\u0000]/.test(file) ? file : resolve(rootDir, file) }
  })
}

function defaultSpawn(command: string, args: string[], options: ViteHubCliSpawnOptions = {}) {
  return new Promise<ViteHubCliSpawnResult>((resolveResult, reject) => {
    const shell = process.platform === "win32" && command !== process.execPath
    const child = spawn(command, shell ? args.map(arg => quoteSupportedInstallSpecifier(arg) ?? arg) : args, {
      cwd: options.cwd,
      env: options.env,
      shell,
      stdio: [
        options.stdin || "inherit",
        options.stdout === "stderr" ? process.stderr : options.stdout || "inherit",
        options.stderr || "inherit",
      ],
    })
    const stdout: Buffer[] = []
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk))
    child.stderr?.resume()
    child.on("error", reject)
    child.on("close", (exitCode, signal) => resolveResult({ exitCode, signal, ...(child.stdout ? { stdout: Buffer.concat(stdout).toString("utf8") } : {}) }))
  })
}

async function loadViteConfig(rootDir: string, command: "build" | "serve", mode?: string): Promise<ViteHubCliLoadedConfig> {
  const { resolveConfig } = await import("vite")
  const resolvedMode = mode ?? (command === "build" ? "production" : "development")
  const project = viteCliProjectConfig(rootDir)
  const nitro = createCliDiscoveryNitroCloser()
  const inlineConfig: InlineConfig & { vitehubCliDiscovery: true } = {
    ...project,
    ...(mode ? { mode } : {}),
    plugins: [...project.plugins, nitro.plugin],
    vitehubCliDiscovery: true,
  }
  try {
    return await resolveConfig(inlineConfig, command, resolvedMode)
  }
  finally {
    await nitro.close()
  }
}

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

function isHelpFlag(arg: string | undefined): boolean {
  return arg === "-h" || arg === "--help"
}

async function loadHelpNamespace(args: string[], helpNamespaces: RunViteHubCliOptions["helpNamespaces"]): Promise<ViteHubCliCommandNamespace | undefined> {
  const [name, feature, ...rest] = args
  if (!name || !helpNamespaces || !Object.hasOwn(helpNamespaces, name) || BUILTIN_NAMESPACE_NAMES.has(name)) return
  if (!isHelpFlag(feature) && !rest.some(isHelpFlag)) return
  const namespace = await helpNamespaces[name]!()
  if (namespace && (isHelpFlag(feature) || namespace.features.some(item => item.name === feature))) return namespace
}

function readPackageVersion(): string {
  const manifest = readFileSync(new URL("../package.json", import.meta.url), "utf8")
  const version = /"version"\s*:\s*"([^"\\]+)"/u.exec(manifest)?.[1]
  if (!version) {
    throw cliErrorDiagnostics.CLI_R0002({ message: "[vitehub] The installed @vite-hub/cli package manifest has no valid version." })
  }
  return version
}

function readStageArg(args: readonly string[]): string | undefined {
  let stage: string | undefined
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg.startsWith("--stage=")) stage = arg.slice("--stage=".length) || undefined
    else if (arg === "--stage") {
      const value = args[++index]
      stage = value && !value.startsWith("-") ? value : undefined
    }
  }
  return stage
}

export async function runViteHubCli(options: RunViteHubCliOptions = {}): Promise<number> {
  const args = options.args || process.argv.slice(2)
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
  const renamed = renamedCommandMessage(args)
  if (renamed) {
    stderr.write(`${renamed}\n`)
    return 1
  }
  const spawn = options.spawn || defaultSpawn
  const stage = (args[0] === "channels" && (args[1] === "sync" || args[1] === "history")) || args[0] === "seed" ? readStageArg(args) : undefined
  const loadProject = (command: "build" | "serve") => withStdoutOnStderr(async () => {
    const loadConfig = options.loadConfig || loadViteConfig
    const loadNuxtConfig = options.loadNuxtViteConfig || loadNuxtViteConfig
    const config = await (stage ? loadConfig(cwd, command, stage) : loadConfig(cwd, command))
    const nuxtConfig = config.vitehubConfigResolved
      ? undefined
      : await (stage ? loadNuxtConfig(cwd, command, stage) : loadNuxtConfig(cwd, command))
    const plugins = nuxtConfig?.plugins ?? config.plugins
    return {
      contribution: await collectViteHubCliContribution(plugins),
      handlers: resolveRouteHandlers(nuxtConfig ? nuxtConfig.nitro : config.nitro, nuxtConfig?.root || config.root || cwd),
      operations: await loadCliOperations(plugins, stderr),
      plugins,
      rootDir: resolve(nuxtConfig?.root || config.root || cwd),
    }
  }, stderr)
  const loadProvision: LoadProvision = options.loadProvision ?? (async (host) => {
    const discoveryEnv = { ...env }
    return await withViteStageEnvironment({ ...discoveryEnv, VITEHUB_HOST: host, VITEHUB_HOST_SOURCE: "cli" }, async () => {
      const loaded = await loadProject("build")
      const provisionEnv = { ...process.env, VITEHUB_HOST: discoveryEnv.VITEHUB_HOST, VITEHUB_HOST_SOURCE: discoveryEnv.VITEHUB_HOST_SOURCE }
      return { env: provisionEnv, rootDir: loaded.rootDir, steps: loaded.contribution.provision }
    })
  })
  const loadCommands = async () => options.commands ?? [...await loadSetupCommands(), drainCommand]
  const setupCommand = options.commands || setupCommandNames.includes(args[0] ?? "")
    ? (await loadCommands()).find(item => item.name === args[0])
    : undefined
  if (setupCommand) {
    return await setupCommand.run(args.slice(1), { cwd, env, ...(options.fetch ? { fetch: options.fetch } : {}), loadProvision, rootDir: cwd, ...(options.runHostCli ? { runHostCli: options.runHostCli } : {}), spawn, stderr, stdout })
  }
  const provisionNamespace = createProvisionNamespace(loadProvision)
  if (args[0] === provisionNamespace.name && (!args[1] || isHelpFlag(args[1]) || provisionNamespace.features.some(feature => feature.name === args[1]))) {
    return await runNamespace(provisionNamespace, args, { cwd, env, ...(options.fetch ? { fetch: options.fetch } : {}), rootDir: cwd, ...(options.runHostCli ? { runHostCli: options.runHostCli } : {}), spawn, stderr, stdout })
  }
  const runtimeNamespace = options.runtimeNamespaces?.find(namespace => namespace.name === args[0] && !BUILTIN_NAMESPACE_NAMES.has(namespace.name))
  if (runtimeNamespace) return await runNamespace(runtimeNamespace, args, { cwd, env, rootDir: cwd, spawn, stderr, stdout })
  const runtimeFeatures = [...options.runtimeFeatures ?? [], hostEnvFeatures].find(namespace => !BUILTIN_NAMESPACE_NAMES.has(namespace.name) && namespace.name === args[0] && namespace.features.some(feature => feature.name === args[1]))
  if (runtimeFeatures && (await options.runtimeFeatureGuard?.(args[0]!, args[1]!, cwd) ?? true)) {
    return await runNamespace(runtimeFeatures, args, { cwd, env, ...(options.fetch ? { fetch: options.fetch } : {}), rootDir: cwd, ...(options.runHostCli ? { runHostCli: options.runHostCli } : {}), spawn, stderr, stdout })
  }

  const helpNamespace = await loadHelpNamespace(args, options.helpNamespaces)
  if (helpNamespace) return await runNamespace(helpNamespace, args, { cwd, env, rootDir: cwd, spawn, stderr, stdout })

  const command = args[0] === "inspect" && (args[1] === "output" || args[1] === "resources" || args[1] === "routes") ? "build" : "serve"
  const runtimeNamespaces = (options.runtimeNamespaces ?? []).filter(namespace => !BUILTIN_NAMESPACE_NAMES.has(namespace.name))
  let project: Awaited<ReturnType<typeof loadProject>>
  try {
    project = await (stage ? withViteStageEnvironment(env, () => loadProject(command)) : loadProject(command))
  }
  catch (error: unknown) {
    const envHelp = args[0] === hostEnvFeatures.name && isHelpFlag(args[1])
    if (args.length && !isRootHelp(args) && !envHelp) throw error
    stderr.write(`${formatRuntimeDiagnosticError(error)}\n`)
    if (envHelp) {
      stderr.write(`${ENV_HELP_WITHOUT_CONFIG}\n\n`)
      writeNamespaceHelp(hostEnvFeatures, stdout)
      return 1
    }
    stderr.write(`${ROOT_HELP_WITHOUT_CONFIG}\n\n`)
    writeRootHelp([provisionNamespace, ...runtimeNamespaces, hostEnvFeatures], await loadCommands(), stdout)
    return 1
  }
  const { contribution, handlers, operations, plugins, rootDir } = project
  const runtimeNames = new Set(runtimeNamespaces.map(namespace => namespace.name))
  const namespaces = [
    ...mergeOperationNamespaces(contribution.namespaces, createOperationNamespaces(operations)).filter(namespace => !BUILTIN_NAMESPACE_NAMES.has(namespace.name) && !runtimeNames.has(namespace.name)),
    createInspectNamespace(plugins, operations, handlers),
    provisionNamespace,
    createSeedNamespace(contribution.seeds),
    ...runtimeNamespaces,
  ]
  const envIndex = namespaces.findIndex(namespace => namespace.name === hostEnvFeatures.name)
  const envNamespace = namespaces[envIndex]
  if (envNamespace) namespaces[envIndex] = { ...envNamespace, features: [...envNamespace.features, ...hostEnvFeatures.features.filter(feature => !envNamespace.features.some(item => item.name === feature.name))] }
  else namespaces.push(hostEnvFeatures)

  const context: ViteHubCliContext = {
    cwd,
    env,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(contribution.publicUrl ? { publicUrl: contribution.publicUrl } : {}),
    rootDir,
    ...(options.runHostCli ? { runHostCli: options.runHostCli } : {}),
    spawn,
    stderr,
    stdout,
  }

  if (!args.length || isRootHelp(args)) {
    writeRootHelp(namespaces, await loadCommands(), stdout)
    return 0
  }

  const namespaceName = args[0]!
  const namespace = namespaces.find(item => item.name === namespaceName)
  if (!namespace) {
    stderr.write(`Unknown ViteHub CLI namespace: ${namespaceName}\n`)
    if (namespaces.every(item => BUILTIN_NAMESPACE_NAMES.has(item.name) || item === hostEnvFeatures)) {
      stderr.write(`No ViteHub integration contributed the "${namespaceName}" commands. Run this from a configured project and enable the matching integration in vite.config.ts or nuxt.config.ts.\n`)
    }
    writeRootHelp(namespaces, await loadCommands(), stderr)
    return 1
  }

  return await runNamespace(namespace, args, context)
}

async function runNamespace(namespace: ViteHubCliCommandNamespace, args: string[], context: ViteHubCliContext): Promise<number> {
  const { stderr, stdout } = context
  const featureName = args[1]
  const defaultFeature = namespace.defaultFeature ? namespace.features.find(item => item.name === namespace.defaultFeature) : undefined
  if (defaultFeature?.name === namespace.name && namespace.features.length === 1) return await defaultFeature.run(args.slice(1), context) ?? 0
  if (featureName === "-h" || featureName === "--help") {
    writeNamespaceHelp(namespace, stdout)
    return 0
  }
  if (defaultFeature && (!featureName || featureName.startsWith("-") || !namespace.features.some(item => item.name === featureName))) return await defaultFeature.run(args.slice(1), context) ?? 0
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
