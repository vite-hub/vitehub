import { readFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { basename, dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { createCodex } from "@ai-sdk/harness-codex"

import { createLocalHarnessSandbox, type LocalHarnessSandboxOptions } from "./local-sandbox.ts"
import { adaptCodexHarnessSandbox, codexBridgeNodeModulesEnv, stripGatewaySecrets, stripGitHubSecrets } from "../internal/codex-sandbox.ts"

import type { CodexHarnessSettings } from "@ai-sdk/harness-codex"
import type {
  AgentHarnessDriver,
  AgentHarnessSandboxProviderInput,
  AgentInvocationContextValues,
  AgentRuntimeConfig,
  CodexDriverOptions,
  CodexDriverSandboxOptions,
} from "../types.ts"

const harnessSandboxAdapter = Symbol.for("vitehub.harnessSandboxAdapter")
const harnessInvocationSandboxAdapter = Symbol.for("vitehub.harnessInvocationSandboxAdapter")
const harnessGlobalSkillsDirectory = Symbol.for("vitehub.harnessGlobalSkillsDirectory")
const harnessSessionPrepare = Symbol.for("vitehub.harnessSessionPrepare")
const harnessDisposableProfile = Symbol.for("vitehub.harnessDisposableProfile")
declare const __VITEHUB_CODEX_BRIDGE_ASSETS__: Record<CodexBridgeAssetName, string> | undefined
const bundledCodexBridgeAssets = typeof __VITEHUB_CODEX_BRIDGE_ASSETS__ === "undefined" ? undefined : __VITEHUB_CODEX_BRIDGE_ASSETS__
export function createCodexDriver<CALL_OPTIONS = unknown, TOutput = unknown>(options: CodexDriverOptions<CALL_OPTIONS, TOutput> = {}): AgentHarnessDriver<AgentRuntimeConfig, CALL_OPTIONS, AgentInvocationContextValues, TOutput> {
  const {
    capacity,
    credentials,
    env,
    instructions,
    output,
    sandbox,
    workDir,
    ...settings
  } = options
  const defaultOpenAIAuth = settings.auth === undefined
  const auth = settings.auth ?? { openai: {} }
  // The upstream harness pins a model when this is undefined, which bypasses the operator's Codex profile.
  const model = settings.model ?? ""
  const sandboxProvider = codexSandboxProvider({
    env,
    preferOpenAI: defaultOpenAIAuth,
    sandbox,
  })

  return {
    ...(capacity !== undefined ? { capacity } : {}),
    credentials: credentials ?? { label: "Codex", source: "ambient" },
    harness: createViteHubCodex({ ...settings, auth, model }, defaultOpenAIAuth),
    ...(instructions !== undefined ? { instructions } : {}),
    ...(output !== undefined ? { output } : {}),
    requires: [
      defaultOpenAIAuth ? { name: "Codex", command: "codex", args: ["login", "status"] } : "codex",
    ],
    ...(sandboxProvider ? { sandbox: sandboxProvider } : {}),
    ...(workDir !== undefined ? { workDir } : {}),
  }
}

const codexBootstrapDir = "/tmp/harness/codex"
const codexBridgeInstallCommand = `if command -v corepack >/dev/null 2>&1 && corepack pnpm@10.33.2 --dir ${codexBootstrapDir} install --ignore-workspace --frozen-lockfile --store-dir ${codexBootstrapDir}/.pnpm-store; then :; else pnpm --dir ${codexBootstrapDir} install --ignore-workspace --frozen-lockfile --store-dir ${codexBootstrapDir}/.pnpm-store; fi`
const codexBridgeNodeModules = `${codexBootstrapDir}/node_modules`
const codexBridgeDependencyVersions = {
  "@openai/codex-sdk/package.json": "0.144.5",
  "ws/package.json": "8.21.0",
}
const codexBridgeDefaultNodeModules = packageNodeModules([
  typeof import.meta.url === "string" ? fileURLToPath(import.meta.url) : undefined,
  resolvePackageEntry("@openai/codex-sdk"),
  resolvePackageEntry("ws"),
]) ?? ""
const codexBridgeDefaultPackageRoots = {
  "@openai/codex-sdk": resolvePackageRoot(resolvePackageEntry("@openai/codex-sdk"), "@openai/codex-sdk", "0.144.5") ?? "",
  "ws": resolvePackageRoot(resolvePackageEntry("ws"), "ws", "8.21.0") ?? "",
}
const codexBridgeComposedNodeModules = `${codexBootstrapDir}/package-node_modules`
const codexBridgePackageRootVariables = Object.entries(codexBridgeDefaultPackageRoots).map(([name, root]) => `codex_bridge_package_${name.replace(/\W/g, "_")}=${shellQuote(root)}`)
const codexBridgePackageRootsReadable = Object.keys(codexBridgeDefaultPackageRoots).map(name => `[ -r "$codex_bridge_package_${name.replace(/\W/g, "_")}/package.json" ]`).join(" && ")
const codexBridgeComposePackageTreeCommand = Object.keys(codexBridgeDefaultPackageRoots).flatMap((name) => {
  const variable = `codex_bridge_package_${name.replace(/\W/g, "_")}`
  const target = `${codexBridgeComposedNodeModules}/${name}`
  return [`mkdir -p ${shellQuote(dirname(target))}`, `rm -f ${shellQuote(target)}`, `ln -s "$${variable}" ${shellQuote(target)}`]
}).join("; ")
const codexBridgeDependencyValidation = `node -e ${shellQuote("const { readFileSync } = require('node:fs'); const { join } = require('node:path'); const [root, versionsJson] = process.argv.slice(1); for (const [marker, version] of Object.entries(JSON.parse(versionsJson))) { if (JSON.parse(readFileSync(join(root, marker), 'utf8')).version !== version) process.exit(1) }")} \"$codex_bridge_node_modules\" ${shellQuote(JSON.stringify(codexBridgeDependencyVersions))}`
const codexBridgePrepareDependenciesCommand = [
  `codex_bridge_node_modules="\${${codexBridgeNodeModulesEnv}:-}"`,
  ...codexBridgePackageRootVariables,
  `if [ -z "$codex_bridge_node_modules" ]; then codex_bridge_node_modules=${shellQuote(codexBridgeDefaultNodeModules)}; fi`,
  `if [ -z "$codex_bridge_node_modules" ] && ${codexBridgePackageRootsReadable}; then ${codexBridgeComposePackageTreeCommand}; codex_bridge_node_modules=${shellQuote(codexBridgeComposedNodeModules)}; fi`,
  `if [ -z "$codex_bridge_node_modules" ]; then codex_bridge_node_modules="${codexBridgeNodeModules}"; if [ ! -d "$codex_bridge_node_modules" ] || ! ${codexBridgeDependencyValidation}; then if [ -L "$codex_bridge_node_modules" ]; then rm -f "$codex_bridge_node_modules"; fi; ${codexBridgeInstallCommand} || exit $?; fi`,
  `elif [ "\${codex_bridge_node_modules#/}" = "$codex_bridge_node_modules" ]; then printf '%s\\n' "[vitehub] ${codexBridgeNodeModulesEnv} must be an absolute sandbox path: $codex_bridge_node_modules" >&2; exit 1`,
  `elif ! ${codexBridgeDependencyValidation}; then if [ -n "\${${codexBridgeNodeModulesEnv}:-}" ]; then printf '%s\\n' "[vitehub] ${codexBridgeNodeModulesEnv} must contain the exact Codex bridge dependencies: $codex_bridge_node_modules" >&2; exit 1; fi; ${codexBridgeInstallCommand} || exit $?; codex_bridge_node_modules="${codexBridgeNodeModules}"`,
  "fi",
  `if [ "$codex_bridge_node_modules" != "${codexBridgeNodeModules}" ] && [ -d "${codexBridgeNodeModules}" ] && [ ! -L "${codexBridgeNodeModules}" ] && [ -z "\${${codexBridgeNodeModulesEnv}:-}" ]; then codex_bridge_node_modules="${codexBridgeNodeModules}"; if ! ${codexBridgeDependencyValidation}; then ${codexBridgeInstallCommand} || exit $?; fi; fi`,
  `if [ "$codex_bridge_node_modules" = "${codexBridgeNodeModules}" ]; then :`,
  `elif [ -L "${codexBridgeNodeModules}" ]; then if [ "$(readlink "${codexBridgeNodeModules}")" != "$codex_bridge_node_modules" ]; then if [ -n "\${${codexBridgeNodeModulesEnv}:-}" ]; then printf '%s\\n' "[vitehub] ${codexBridgeNodeModules} already links to a different dependency tree" >&2; exit 1; fi; ln -sfn "$codex_bridge_node_modules" "${codexBridgeNodeModules}"; fi`,
  `elif [ -e "${codexBridgeNodeModules}" ]; then printf '%s\\n' "[vitehub] ${codexBridgeNodeModules} already exists and conflicts with ${codexBridgeNodeModulesEnv}" >&2; exit 1`,
  `else ln -s "$codex_bridge_node_modules" "${codexBridgeNodeModules}"`,
  "fi",
].join("; ")

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function resolvePackageEntry(specifier: string): string | undefined {
  try {
    return fileURLToPath(import.meta.resolve(specifier))
  }
  catch {
    return undefined
  }
}

function resolvePackageRoot(entry: string | undefined, name: string, version: string): string | undefined {
  if (!entry) return undefined
  let directory = dirname(entry)
  while (true) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"))
      if (manifest.name === name && manifest.version === version) return directory
    }
    catch {}
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

function packageNodeModules(entries: Array<string | undefined>): string | undefined {
  for (const entry of entries) {
    if (!entry) continue
    let directory = dirname(entry)
    while (true) {
      const candidates = [
        ...(basename(directory) === "node_modules" ? [directory] : []),
        join(directory, "node_modules"),
      ]
      const nodeModules = candidates.find(hasCodexBridgeDependencies)
      if (nodeModules) return nodeModules
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }
  const workingDirectoryNodeModules = join(process.cwd(), "node_modules")
  if (hasCodexBridgeDependencies(workingDirectoryNodeModules)) return workingDirectoryNodeModules
}

function hasCodexBridgeDependencies(nodeModules: string): boolean {
  return Object.entries(codexBridgeDependencyVersions).every(([marker, version]) => {
    try {
      return JSON.parse(readFileSync(join(nodeModules, marker), "utf8")).version === version
    }
    catch {
      return false
    }
  })
}

function createViteHubCodex(settings: CodexHarnessSettings, preferOpenAI: boolean) {
  const harness = createCodex(settings)
  const adaptSandbox = (
    provider: AgentHarnessSandboxProviderInput,
    options?: { box?: boolean, defaultSandbox?: boolean, invocation?: { id: string, isolateBoxHome: boolean } },
  ) => adaptCodexHarnessSandbox(provider, {
    ...(options?.box && options.invocation?.isolateBoxHome
      ? { codexHomeRelativeToHome: `.vitehub/codex-home-${options.invocation.id}` }
      : {}),
    defaultSandbox: options?.defaultSandbox,
    isolateHome: !options?.box || options.invocation?.isolateBoxHome,
    preferOpenAI,
  })
  return {
    ...harness,
    [harnessDisposableProfile]: true,
    [harnessGlobalSkillsDirectory]: (context: { box?: unknown }, invocation?: { id: string, isolateBoxHome: boolean }) => context.box
      ? invocation?.isolateBoxHome
        ? `.vitehub/codex-home-${invocation.id}/skills`
        : ".codex/skills"
      : "tmp/harness/codex-home/skills",
    [harnessSessionPrepare]: async (session: object, invocation?: { id: string, isolateBoxHome: boolean }) => {
      return await prepareCodexHome(session, invocation)
    },
    [harnessSandboxAdapter]: adaptSandbox,
    [harnessInvocationSandboxAdapter]: adaptSandbox,
    async getBootstrap() {
      const [pkg, lock, bridge] = await Promise.all([
        readCodexBridgeAsset("package.json"),
        readCodexBridgeAsset("pnpm-lock.yaml"),
        readCodexBridgeAsset("index.mjs"),
      ])
      return {
        bootstrapDir: codexBootstrapDir,
        commands: [
          { command: `mkdir -p ${codexBootstrapDir}` },
          { command: codexBridgePrepareDependenciesCommand },
        ],
        files: [
          { content: pkg, path: `${codexBootstrapDir}/package.json` },
          { content: lock, path: `${codexBootstrapDir}/pnpm-lock.yaml` },
          { content: bridge, path: `${codexBootstrapDir}/bridge.mjs` },
        ],
        harnessId: "codex",
      }
    },
  }
}

type CodexBridgeAssetName = "index.mjs" | "package.json" | "pnpm-lock.yaml"

async function readCodexBridgeAsset(name: CodexBridgeAssetName): Promise<string> {
  if (bundledCodexBridgeAssets) return bundledCodexBridgeAssets[name]
  const packageEntry = createRequire(import.meta.url).resolve("@ai-sdk/harness-codex")
  return await readFile(fileURLToPath(new URL(`./bridge/${name}`, pathToFileURL(packageEntry))), "utf8")
}

async function prepareCodexHome(session: object, invocation?: { id?: string, isolateBoxHome: boolean }): Promise<{ close: (error?: unknown) => Promise<void> } | undefined> {
  const sandbox = session as { run(options: { command: string, env?: Record<string, string | undefined> }): Promise<{ exitCode: number, stderr?: string }> }
  const result = await sandbox.run({
    command:
      'codex_home="${CODEX_HOME:-$HOME/.codex}" && ambient_home="${VITEHUB_AMBIENT_CODEX_HOME:-$HOME/.codex}" && mkdir -p "$codex_home" && chmod 700 "$codex_home" && if [ "$codex_home" != "$ambient_home" ]; then if [ -f "$ambient_home/auth.json" ] && [ ! -e "$codex_home/auth.json" ]; then cp "$ambient_home/auth.json" "$codex_home/auth.json" && chmod 600 "$codex_home/auth.json"; fi && if [ -f "$ambient_home/config.toml" ] && [ ! -e "$codex_home/config.toml" ]; then cp "$ambient_home/config.toml" "$codex_home/config.toml"; fi; fi && if [ ! -e "$codex_home/config.toml" ]; then : > "$codex_home/config.toml"; fi && chmod 600 "$codex_home/config.toml"',
  })
  if (result.exitCode !== 0) {
    if (invocation?.isolateBoxHome && invocation.id) {
      await sandbox.run({ command: `rm -rf -- "$HOME/.vitehub/codex-home-${invocation.id}"` }).catch(() => undefined)
    }
    throw new Error(`[vitehub] Failed to prepare Codex Home: ${result.stderr || "sandbox command failed"}`)
  }
  if (!invocation?.isolateBoxHome || !invocation.id) return
  return {
    async close() {
      const cleanup = await sandbox.run({
        command: `rm -rf -- "$HOME/.vitehub/codex-home-${invocation.id}"`,
      })
      if (cleanup.exitCode !== 0) {
        throw new Error(`[vitehub] Failed to remove the invocation Codex Home: ${cleanup.stderr || "sandbox command failed"}`)
      }
    },
  }
}

function codexSandboxProvider(options: {
  env?: Record<string, string | undefined>
  preferOpenAI: boolean
  sandbox?: CodexDriverSandboxOptions
}): AgentHarnessDriver["sandbox"] | undefined {
  const { sandbox } = options
  if (sandbox === false) return
  if (typeof sandbox === "function" || isHarnessSandboxProvider(sandbox)) return sandbox
  if (sandbox === undefined && options.env === undefined) return

  const localOptions = sandbox as LocalHarnessSandboxOptions | undefined
  return adaptCodexHarnessSandbox(createLocalHarnessSandbox({
    ...localOptions,
    env: codexLocalEnv({
      env: {
        ...options.env,
        ...localOptions?.env,
      },
      preferOpenAI: options.preferOpenAI,
    }),
  }))
}

function isHarnessSandboxProvider(value: unknown): value is AgentHarnessSandboxProviderInput {
  if (!value || typeof value !== "object") return false
  const provider = value as { createSession?: unknown, specificationVersion?: unknown }
  return typeof provider.createSession === "function" || provider.specificationVersion === "harness-sandbox-v1"
}

function codexLocalEnv(options: {
  env?: Record<string, string | undefined>
  preferOpenAI: boolean
}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...options.env,
  }
  stripGitHubSecrets(env)

  if (options.preferOpenAI) {
    stripGatewaySecrets(env)
  }

  env.PATH = [
    join(process.cwd(), "node_modules", ".bin"),
    env.HOME ? join(env.HOME, ".local", "bin") : undefined,
    env.PATH,
  ].filter(Boolean).join(":")
  return env
}
