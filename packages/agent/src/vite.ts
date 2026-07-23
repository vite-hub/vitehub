import { existsSync, readFileSync, statSync } from "node:fs"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { writeProviderDeploymentOutputs } from "@vite-hub/internal/build/deployment-output"
import { copyVercelFunctionRuntimePackages } from "@vite-hub/internal/build/vercel-runtime-packages"
import { createNoExternalMerger, isServerEnvironment, mergeGeneratedViteHubWatchIgnored } from "@vite-hub/internal/build/vite"
import { getHostingProvider } from "@vite-hub/internal/hosting"

import { registerAgentInvocationStreamEndpoint } from "./vite/invocation-stream-endpoint.ts"
import {
  configureCloudflareAgentState,
  defaultCloudflareAgentStateBinding,
  installCloudflareAgentStateEntrypoint,
} from "./cloudflare.ts"
import { normalizeAgentOptions } from "./config.ts"
import { discoverAgentDefinitions } from "./discovery.ts"
import { resolveInstructionImports } from "./instruction-composition.ts"
import { resolveAgentEvalOptions, writeAgentEvaliteConfig } from "./internal/evalite-config.ts"
import { readColocatedAgentSkills } from "./vite/colocated-agent-skills.ts"

import type { Plugin, ResolvedConfig } from "vite"
import type { CloudflareAgentStateMigration, CloudflareAgentStateRollupTarget, CloudflareAgentStateTarget } from "./cloudflare.ts"
import type { AgentModuleOptions, DiscoveredAgentDefinition, ResolvedAgentModuleOptions } from "./types.ts"

interface AgentCliContributingPlugin {
  vitehub?: {
    cli?: unknown
  }
}

export type AgentVitePlugin = Plugin & AgentCliContributingPlugin

const agentPackageName = "@vite-hub/agent"
const mergeNoExternal = createNoExternalMerger(agentPackageName)
const generatedAgentDenoServer = ".vitehub/agent/deno-server.ts"
const generatedAgentDiscordGatewayRouteHandler = ".vitehub/agent/discord-gateway-route.ts"
const generatedAgentWebhookRouteHandler = ".vitehub/agent/chat-webhook-route.ts"
const generatedAgentNetlifyFunction = ".vitehub/agent/netlify-function.mjs"
const generatedAgentEmailRuntime = ".vitehub/agent/email-runtime.js"
const generatedAgentScheduleRegistry = ".vitehub/agent/schedule-registry.js"
const netlifyAgentFunctionName = "vitehub-agent"
const generatedScheduleRuntimeRegistrySuffix = "/.vitehub/nitro/schedule/runtime-registry.js"
const scheduleRegistryId = "#vitehub/schedule/registry"
const resolvedScheduleRegistryId = `\0${scheduleRegistryId}`
const resolvedScheduleTargetsId = "\0#vitehub/schedule/targets"
const scheduleRuntimeImport = "@vite-hub/schedule/runtime"
const scheduleVitePluginName = "@vite-hub/schedule/vite"
const workspacePackageName = "@vite-hub/workspace"
const optionalMessageAdapterRuntimeExternals = [
  "bufferutil",
  "utf-8-validate",
  "zlib-sync",
]
const optionalNetlifyAgentBundleExternals = [
  "@ai-sdk/harness",
  "@ai-sdk/harness/*",
  "@ai-sdk/mcp",
  "@modelcontextprotocol/sdk/*",
  "@vite-hub/sandbox",
  "@vite-hub/sandbox/*",
  "@vite-hub/shell",
  "@vite-hub/shell/*",
  "@vite-hub/workflow",
  "@vite-hub/workflow/*",
  "agents",
  "evalite/*",
  ...optionalMessageAdapterRuntimeExternals,
  "vitest/*",
]

function resolveNetlifyAgentBundleExternals(options: AgentGeneratedImportOptions): string[] {
  const bundled = new Set<string>()
  if (options.workflowImportBase) {
    bundled.add("@vite-hub/workflow")
    bundled.add("@vite-hub/workflow/*")
  }
  if (options.workspaceDependencyRuntimeImports?.sandbox || options.workspaceDependencyRuntimeImports?.sandboxRuntimeState) {
    bundled.add("@vite-hub/sandbox")
    bundled.add("@vite-hub/sandbox/*")
  }
  if (options.workspaceDependencyRuntimeImports?.shellWorkspace) {
    bundled.add("@vite-hub/shell")
    bundled.add("@vite-hub/shell/*")
  }
  return optionalNetlifyAgentBundleExternals.filter(specifier => !bundled.has(specifier))
}

interface InternalAgentModuleOptions extends AgentModuleOptions {
  cloudflareStateImport?: string
  importBase?: string
  providerImportAliases?: Record<string, string>
  runtimeCapabilityImports?: Record<string, string>
  scheduleRuntimeImport?: string
  workflowImportBase?: string
  workspaceDependencyRuntimeImports?: WorkspaceDependencyRuntimeImports
  workspaceImportBase?: string
}

interface AgentGeneratedImportOptions {
  agentImportBase?: string
  providerImportAliases?: Record<string, string>
  runtimeCapabilities?: GeneratedAgentRuntimeCapability[]
  schedule?: boolean
  scheduleRegistryImport?: string
  scheduleRuntimeImport?: string
  workflowImportBase?: string
  workspaceDependencyRuntimeImports?: WorkspaceDependencyRuntimeImports
  workspaceImportBase?: string
}

interface WorkspaceDependencyRuntimeImports {
  sandbox?: string
  sandboxRuntimeState?: string
  shellWorkspace?: string
}

interface GeneratedAgentRuntimeCapability {
  importName: string
  name: string
  packageName: string
  pluginName: string
}

const generatedAgentRuntimeCapabilityDefinitions: GeneratedAgentRuntimeCapability[] = [
  { importName: "blob", name: "blob", packageName: "@vite-hub/blob", pluginName: "@vite-hub/blob/vite" },
  { importName: "email", name: "email", packageName: "@vite-hub/email/server", pluginName: "@vite-hub/email/vite" },
  { importName: "kv", name: "kv", packageName: "@vite-hub/kv", pluginName: "@vite-hub/kv/vite" },
]

async function resolveGeneratedAgentRuntimeCapabilities(
  config: Pick<ResolvedConfig, "plugins" | "root"> & Partial<Pick<ResolvedConfig, "createResolver">>,
  packageImports: Record<string, string> = {},
): Promise<GeneratedAgentRuntimeCapability[]> {
  const pluginNames = new Set(config.plugins?.map(plugin => plugin.name))
  const candidates = generatedAgentRuntimeCapabilityDefinitions.filter(capability => pluginNames.has(capability.pluginName))
  const resolveImport = config.createResolver?.()
  if (!resolveImport) {
    return candidates.map(capability => ({
      ...capability,
      packageName: packageImports[capability.name] ?? capability.packageName,
    }))
  }
  const importer = join(config.root, ".vitehub", "agent", "runtime-capabilities.js")
  const resolved = await Promise.all(candidates.map(async (capability) => {
    const packageName = packageImports[capability.name] ?? capability.packageName
    return await resolveImport(packageName, importer)
      ? { ...capability, packageName }
      : undefined
  }))
  return resolved.filter((capability): capability is GeneratedAgentRuntimeCapability => capability !== undefined)
}

function generatedAgentRuntimeCapabilityAlias(capability: GeneratedAgentRuntimeCapability): string {
  return `vitehub${capability.name[0]!.toUpperCase()}${capability.name.slice(1)}`
}

function generatedAgentRuntimeCapabilityImports(capabilities: GeneratedAgentRuntimeCapability[]): string[] {
  return capabilities.map(capability => `import { ${capability.importName} as ${generatedAgentRuntimeCapabilityAlias(capability)} } from ${JSON.stringify(capability.packageName)}`)
}

function generatedAgentRuntimeCapabilities(capabilities: GeneratedAgentRuntimeCapability[], schedule: boolean): string {
  const entries = capabilities.map(capability => `${capability.name}: ${generatedAgentRuntimeCapabilityAlias(capability)}`)
  if (schedule) entries.push("schedule: { schedules: vitehubSchedules }")
  return `{ ${entries.join(", ")} }`
}

async function writeStandaloneAgentRuntimeCapabilities(
  config: Pick<ResolvedConfig, "plugins" | "root">,
  capabilities: GeneratedAgentRuntimeCapability[],
): Promise<GeneratedAgentRuntimeCapability[]> {
  const emailCapability = capabilities.find(capability => capability.name === "email")
  const emailPlugin = config.plugins?.find(plugin => plugin.name === "@vite-hub/email/vite") as Plugin & {
    api?: { getDefinition?: () => { handler: string } | undefined }
  }
  const definition = emailPlugin?.api?.getDefinition?.()
  const runtimePath = join(config.root, generatedAgentEmailRuntime)
  if (!emailCapability || !definition) {
    await rm(runtimePath, { force: true })
    return capabilities
  }

  const emailImport = emailCapability.packageName.endsWith("/server")
    ? emailCapability.packageName.slice(0, -"/server".length)
    : "@vite-hub/email"
  await mkdir(dirname(runtimePath), { recursive: true })
  await writeFile(runtimePath, [
    `import { createEmail } from ${JSON.stringify(emailImport)}`,
    `import definition from ${JSON.stringify(moduleImportSpecifier(runtimePath, definition.handler))}`,
    "export const email = createEmail(definition)",
    "",
  ].join("\n"), "utf8")
  return capabilities.map(capability => capability === emailCapability
    ? { ...capability, packageName: "./email-runtime.js" }
    : capability)
}

function getInternalAgentOptions(options: AgentModuleOptions | false | undefined): InternalAgentModuleOptions | undefined {
  return options && typeof options === "object" ? options as InternalAgentModuleOptions : undefined
}

function getAgentImportBase(options: AgentModuleOptions | false | undefined, fallback?: InternalAgentModuleOptions): string {
  return getInternalAgentOptions(options)?.importBase ?? fallback?.importBase ?? agentPackageName
}

function getProviderImportAliases(
  options: AgentModuleOptions | false | undefined,
  fallback?: InternalAgentModuleOptions,
): Record<string, string> | undefined {
  return getInternalAgentOptions(options)?.providerImportAliases ?? fallback?.providerImportAliases
}

function getWorkspaceImportBase(options: AgentModuleOptions | false | undefined, fallback?: InternalAgentModuleOptions): string {
  return getInternalAgentOptions(options)?.workspaceImportBase ?? fallback?.workspaceImportBase ?? workspacePackageName
}

function getScheduleRuntimeImport(options: AgentModuleOptions | false | undefined, fallback?: InternalAgentModuleOptions): string {
  return getInternalAgentOptions(options)?.scheduleRuntimeImport ?? fallback?.scheduleRuntimeImport ?? scheduleRuntimeImport
}

function getCloudflareStateImport(options: AgentModuleOptions | false | undefined, fallback?: InternalAgentModuleOptions): string {
  return getInternalAgentOptions(options)?.cloudflareStateImport ?? fallback?.cloudflareStateImport ?? "@vite-hub/agent/cloudflare/state"
}

function getWorkflowImportBase(options: AgentModuleOptions | false | undefined, fallback?: InternalAgentModuleOptions): string | undefined {
  return getInternalAgentOptions(options)?.workflowImportBase ?? fallback?.workflowImportBase
}

function getWorkspaceDependencyRuntimeImports(
  options: AgentModuleOptions | false | undefined,
  fallback?: InternalAgentModuleOptions,
): WorkspaceDependencyRuntimeImports | undefined {
  return getInternalAgentOptions(options)?.workspaceDependencyRuntimeImports ?? fallback?.workspaceDependencyRuntimeImports
}

function generatedAgentRouteCapabilities(options: AgentGeneratedImportOptions) {
  const runtimeCapabilities = options.runtimeCapabilities ?? []
  if (!options.schedule && !runtimeCapabilities.length) return { imports: [] as string[], requestOption: "", requestProperty: "", setup: [] as string[] }
  return {
    imports: [
      ...generatedAgentRuntimeCapabilityImports(runtimeCapabilities),
      ...(options.schedule
        ? [
            `import vitehubAgentScheduleRegistry from ${JSON.stringify(options.scheduleRegistryImport ?? scheduleRegistryId)}`,
            `import { schedules as vitehubSchedules, setScheduleRuntimeRegistry as vitehubSetScheduleRuntimeRegistry } from ${JSON.stringify(options.scheduleRuntimeImport ?? scheduleRuntimeImport)}`,
          ]
        : []),
    ],
    requestOption: "capabilities: vitehubAgentRouteCapabilities, ",
    requestProperty: ", capabilities: vitehubAgentRouteCapabilities",
    setup: [
      ...(options.schedule ? ["vitehubSetScheduleRuntimeRegistry(vitehubAgentScheduleRegistry)"] : []),
      `const vitehubAgentRouteCapabilities = ${generatedAgentRuntimeCapabilities(runtimeCapabilities, options.schedule === true)}`,
      "",
    ],
  }
}

function hasScheduleVitePlugin(config: Pick<ResolvedConfig, "plugins">): boolean {
  return config.plugins?.some(plugin => plugin.name === scheduleVitePluginName) === true
}

function isScheduleRegistryId(id: string): boolean {
  if (id === resolvedScheduleRegistryId) return true
  return id.replace(/\\/g, "/").split("?", 1)[0]!.endsWith(generatedScheduleRuntimeRegistrySuffix)
}

function discoverScheduledAgentDefinitions(root: string): DiscoveredAgentDefinition[] {
  const definitions = [
    ...discoverAgentDefinitions({ mode: "vite-suffix", rootDir: root }),
    ...discoverAgentDefinitions({ mode: "server-agents", scanDirs: [join(root, "server")] }),
  ]
  const unique = new Map<string, DiscoveredAgentDefinition>()
  for (const definition of definitions) {
    const existing = unique.get(definition.name)
    if (existing && existing.handler !== definition.handler) {
      throw new Error(`[vitehub] Duplicate Agent name "${definition.name}" cannot be registered as a Runtime Schedule target.`)
    }
    unique.set(definition.name, definition)
  }
  return [...unique.values()]
}

function hasHostedAgentDefinitions(root: string): boolean {
  return discoverAgentDefinitions({
    mode: "server-agents",
    scanDirs: [join(root, "server")],
  }).length > 0
}

async function transformScheduleRegistry(
  code: string,
  definitions: DiscoveredAgentDefinition[],
  agentImportBase: string,
  importAnchor?: string,
  runtimeCapabilities: GeneratedAgentRuntimeCapability[] = [],
  scheduleRuntimeSpecifier = scheduleRuntimeImport,
  generatedImportOptions: AgentGeneratedImportOptions = {},
): Promise<string | undefined> {
  if (!definitions.length) return
  if (!/\b(?:const|let|var)\s+registry\b/.test(code)) {
    throw new Error("[vitehub] Unable to extend the Runtime Schedule registry: expected a registry binding.")
  }
  const entries = (await Promise.all(definitions.map(async (definition) => {
    const sourceRootDir = resolveWorkspaceSourceRoot(definition.handler)
    const agentIdentity = { name: definition.name, ...(definition.workspace ? { workspace: definition.workspace } : {}) }
    const handlerImport = importAnchor ? moduleImportSpecifier(importAnchor, definition.handler) : definition.handler
    return [
      `if (Object.prototype.hasOwnProperty.call(registry, ${JSON.stringify(`agent/${definition.name}`)})) throw new Error(${JSON.stringify(`[vitehub] Duplicate Runtime Schedule target: agent/${definition.name}`)})`,
      `registry[${JSON.stringify(`agent/${definition.name}`)}] = async () => {`,
      `  const module = await import(${JSON.stringify(handlerImport)})`,
      `  return vitehubDefineScheduledAgentTarget(vitehubWithWorkspaceSourceRoot(vitehubResolveScheduledAgentModule(module), ${JSON.stringify(sourceRootDir)}, ${JSON.stringify(await readColocatedAgentInstructions(definition.handler))}, ${JSON.stringify(readColocatedAgentSkills(definition.handler))}), { agentIdentity: ${JSON.stringify(agentIdentity)}, capabilities: ${generatedAgentRuntimeCapabilities(runtimeCapabilities, true)} })`,
      "}",
    ]
  }))).flat()
  const workflowRuntime = generatedAgentWorkflowRuntime(generatedImportOptions, agentImportBase)
  const workspaceRuntime = generatedAgentWorkspaceDependencyRuntime(
    generatedImportOptions,
    generatedImportOptions.workspaceImportBase ?? workspacePackageName,
  )
  return [
    `import { workspaceDefinitionFromOptions as vitehubWorkspaceDefinitionFromOptions } from ${JSON.stringify(agentImportBase)}`,
    `import { defineScheduledAgentTarget as vitehubDefineScheduledAgentTarget } from ${JSON.stringify(subpath(agentImportBase, "server/internal"))}`,
    ...workflowRuntime.imports,
    ...workspaceRuntime.imports,
    ...generatedAgentRuntimeCapabilityImports(runtimeCapabilities),
    `import { schedules as vitehubSchedules } from ${JSON.stringify(scheduleRuntimeSpecifier)}`,
    code,
    "function vitehubResolveScheduledAgentModule(module) {",
    "  return module && typeof module === 'object' && 'default' in module ? module.default : module",
    "}",
    ...generatedWorkspaceSourceRootHelper("vitehubWithWorkspaceSourceRoot", "vitehubWorkspaceDefinitionFromOptions"),
    ...workflowRuntime.setup,
    ...workspaceRuntime.setup,
    ...entries,
    "",
  ].join("\n")
}

async function writeStandaloneAgentScheduleRegistry(
  root: string,
  definitions: DiscoveredAgentDefinition[],
  agentImportBase: string,
  runtimeCapabilities: GeneratedAgentRuntimeCapability[] = [],
  scheduleRuntimeSpecifier = scheduleRuntimeImport,
  generatedImportOptions: AgentGeneratedImportOptions = {},
): Promise<string> {
  const registryPath = join(root, generatedAgentScheduleRegistry)
  const base = ["const registry = {}", "", "export default registry", ""].join("\n")
  const contents = await transformScheduleRegistry(base, definitions, agentImportBase, registryPath, runtimeCapabilities, scheduleRuntimeSpecifier, generatedImportOptions) ?? base
  await mkdir(dirname(registryPath), { recursive: true })
  await writeFile(registryPath, contents, "utf8")
  return registryPath
}

function transformScheduleTargets(code: string, definitions: DiscoveredAgentDefinition[]): string | undefined {
  if (!definitions.length) return
  if (!/\b(?:const|let|var)\s+scheduleTargetNames\b/.test(code)) {
    throw new Error("[vitehub] Unable to extend Runtime Schedule targets: expected a scheduleTargetNames binding.")
  }
  return [
    code,
    ...definitions.map(definition => `if (!scheduleTargetNames.includes(${JSON.stringify(`agent/${definition.name}`)})) scheduleTargetNames.push(${JSON.stringify(`agent/${definition.name}`)})`),
    "",
  ].join("\n")
}

function subpath(base: string, path: string): string {
  return `${base}/${path}`
}

function generatedAgentWorkflowRuntime(options: AgentGeneratedImportOptions, agentImportBase: string) {
  if (!options.workflowImportBase) return { imports: [] as string[], setup: [] as string[] }
  return {
    imports: [`import { setAgentWorkflowRuntimeLoaders as vitehubSetAgentWorkflowRuntimeLoaders } from ${JSON.stringify(subpath(agentImportBase, "server/internal"))}`],
    setup: [
      "vitehubSetAgentWorkflowRuntimeLoaders({",
      `  state: () => import(${JSON.stringify(subpath(options.workflowImportBase, "runtime/state"))}),`,
      `  workflow: () => import(${JSON.stringify(options.workflowImportBase)}),`,
      "})",
      "",
    ],
  }
}

function generatedAgentWorkspaceDependencyRuntime(options: AgentGeneratedImportOptions, workspaceImportBase: string) {
  const imports = options.workspaceDependencyRuntimeImports
  if (!imports) return { imports: [] as string[], setup: [] as string[] }
  return {
    imports: [`import { setWorkspaceDependencyRuntimeLoaders as vitehubSetWorkspaceDependencyRuntimeLoaders } from ${JSON.stringify(subpath(workspaceImportBase, "runtime"))}`],
    setup: [
      "vitehubSetWorkspaceDependencyRuntimeLoaders({",
      ...(imports.sandbox ? [`  sandbox: () => import(${JSON.stringify(imports.sandbox)}),`] : []),
      ...(imports.sandboxRuntimeState ? [`  sandboxRuntimeState: () => import(${JSON.stringify(imports.sandboxRuntimeState)}),`] : []),
      ...(imports.shellWorkspace ? [`  shellWorkspace: () => import(${JSON.stringify(imports.shellWorkspace)}),`] : []),
      "})",
      "",
    ],
  }
}

type NitroConfig = Record<string, unknown> & CloudflareAgentStateRollupTarget & CloudflareAgentStateTarget
type RollupExternalFunction = (source: string, importer?: string, isResolved?: boolean) => boolean | null | undefined | void
type RollupExternalOption = string | RegExp | (string | RegExp)[] | RollupExternalFunction
type BuildWithRolldownOptions = {
  build?: {
    rolldownOptions?: {
      external?: RollupExternalOption
    }
  }
}
type GeneratedLibsqlAgentStateOptions = Pick<ResolvedAgentModuleOptions["providers"]["state"], "tablePrefix" | "url"> & {
  authTokenEnvName?: string
  durableUrlRequired?: boolean
  ephemeralHosting?: "cloudflare" | "netlify" | "vercel"
}

const defaultLocalAgentStateUrl = "file:.data/vitehub-agent-state.sqlite"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function readHostingPreset(value: unknown): string | undefined {
  return isRecord(value) && typeof value.preset === "string" ? value.preset : undefined
}

function resolveAgentHosting(config: unknown): "cloudflare" | "netlify" | "vercel" | undefined {
  const target = isRecord(config) ? config : {}
  const values = [
    readHostingPreset(target.vitehub),
    typeof target.preset === "string" ? target.preset : undefined,
    readHostingPreset(target.nitro),
    process.env.VITEHUB_HOSTING,
  ]
  for (const value of values) {
    const provider = getHostingProvider(value)
    if (provider === "cloudflare" || provider === "netlify" || provider === "vercel") return provider
  }

  if (process.env.CLOUDFLARE_WORKER || process.env.CF_PAGES) return "cloudflare"
  if (process.env.VERCEL || process.env.VERCEL_ENV) return "vercel"
  if (process.env.NETLIFY || process.env.NETLIFY_DEV || process.env.NETLIFY_LOCAL) return "netlify"
}

function shouldInstallCloudflareAgentState(
  options: false | ResolvedAgentModuleOptions,
  config: unknown,
): options is ResolvedAgentModuleOptions {
  if (!options) return false
  const { provider, url } = options.providers.state
  if (provider === "cloudflare" || provider === "cloudflare-agents") return true
  if (provider !== "auto") return false
  if (url) return false
  if (options.runtime === "cloudflare-agents") return true
  if (options.runtime === "vercel" || options.runtime === "deno") return false
  return resolveAgentHosting(config) === "cloudflare"
}

function resolveEnvNameForValue(value: string | undefined): string | undefined {
  if (!value) return
  return Object.entries(process.env)
    .find(([name, envValue]) => name && envValue === value)?.[0]
}

function resolveLibsqlAgentState(
  options: false | ResolvedAgentModuleOptions,
  config: unknown,
): GeneratedLibsqlAgentStateOptions | undefined {
  if (!options) return
  const { authToken, provider, tablePrefix, url } = options.providers.state
  const auto = provider === "auto"
  if (!auto && provider !== "sqlite" && provider !== "libsql") return
  if (auto && shouldInstallCloudflareAgentState(options, config)) return
  const authTokenEnvName = resolveEnvNameForValue(authToken)
  const target = isRecord(config) ? config : {}
  const localDevelopment = target.command === "serve" && options.runtime !== "cloudflare-agents" && options.runtime !== "deno"
  const localDefaultUrl = typeof target.root === "string"
    ? pathToFileURL(resolve(target.root, defaultLocalAgentStateUrl.slice("file:".length))).href
    : defaultLocalAgentStateUrl
  const resolvedUrl = url || (auto && localDevelopment ? localDefaultUrl : undefined)
  const explicitEphemeralHosting = options.runtime === "cloudflare-agents" ? "cloudflare" : options.runtime === "vercel" ? "vercel" : undefined
  const ephemeralHosting = localDevelopment ? undefined : explicitEphemeralHosting || resolveAgentHosting(config)
  if (ephemeralHosting && resolvedUrl?.startsWith("file:")) {
    throw new TypeError(`[vitehub] Agent state cannot use a file: URL on ${ephemeralHosting} because its filesystem is ephemeral. Configure a durable libSQL URL.`)
  }
  return {
    ...(authTokenEnvName ? { authTokenEnvName } : {}),
    ...(!resolvedUrl ? { durableUrlRequired: true } : {}),
    ...(ephemeralHosting ? { ephemeralHosting } : {}),
    ...(tablePrefix ? { tablePrefix } : {}),
    ...(resolvedUrl ? { url: resolvedUrl } : {}),
  }
}

function cloneStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined
}

function cloneCloudflareAgentStateMigrations(value: unknown): CloudflareAgentStateMigration[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.flatMap((item): CloudflareAgentStateMigration[] => {
    if (!isRecord(item) || typeof item.tag !== "string") return []
    return [{
      ...item,
      ...(cloneStringArray(item.deleted_classes) ? { deleted_classes: cloneStringArray(item.deleted_classes) } : {}),
      ...(cloneStringArray(item.new_sqlite_classes) ? { new_sqlite_classes: cloneStringArray(item.new_sqlite_classes) } : {}),
      tag: item.tag,
    }]
  })
}

function mergeRollupExternals(external: RollupExternalOption | undefined, additions: readonly string[]): RollupExternalOption | undefined {
  if (external === undefined) return [...additions]
  if (typeof external === "string") return additions.includes(external) ? [...additions] : [external, ...additions]
  if (external instanceof RegExp) return [external, ...additions]
  if (Array.isArray(external)) {
    const missing = additions.filter(source => !external.includes(source))
    return missing.length ? [...external, ...missing] : external
  }
  if (typeof external === "function") {
    const externalFunction = external as RollupExternalFunction
    return (source: string, importer?: string, isResolved?: boolean) =>
      additions.includes(source) || Boolean(externalFunction(source, importer, isResolved))
  }
  return external
}

function mergeCloudflareWorkersExternal(external: RollupExternalOption | undefined): RollupExternalOption | undefined {
  return mergeRollupExternals(external, ["cloudflare:workers", ...optionalMessageAdapterRuntimeExternals])
}

function mergeBuildExternal(config: BuildWithRolldownOptions, additions: readonly string[]): BuildWithRolldownOptions["build"] {
  const build = (config.build ?? {}) as NonNullable<BuildWithRolldownOptions["build"]> & { rollupOptions?: unknown }
  const rollupOptions = isRecord(build.rollupOptions) ? build.rollupOptions : {}
  delete build.rollupOptions
  build.rolldownOptions = {
    ...rollupOptions,
    ...build.rolldownOptions,
    external: mergeRollupExternals(build.rolldownOptions?.external ?? rollupOptions.external as RollupExternalOption | undefined, additions),
  }
  return {
    ...build,
  }
}

function cloneNitroConfig(value: unknown): NitroConfig {
  const nitro = isRecord(value) ? { ...value } : {}
  if (isRecord(nitro.rollupConfig)) {
    const rollupConfig = { ...nitro.rollupConfig }
    if (Array.isArray(rollupConfig.plugins)) {
      rollupConfig.plugins = [...rollupConfig.plugins]
    }
    nitro.rollupConfig = rollupConfig
  }

  if (isRecord(nitro.cloudflare)) {
    const cloudflare = { ...nitro.cloudflare }
    if (isRecord(cloudflare.wrangler)) {
      const wrangler = { ...cloudflare.wrangler }
      if (isRecord(wrangler.durable_objects)) {
        const durableObjects = { ...wrangler.durable_objects }
        if (Array.isArray(durableObjects.bindings)) {
          durableObjects.bindings = [...durableObjects.bindings]
        }
        wrangler.durable_objects = durableObjects
      }
      const migrations = cloneCloudflareAgentStateMigrations(wrangler.migrations)
      if (migrations) {
        wrangler.migrations = migrations
      }
      cloudflare.wrangler = wrangler
    }
    nitro.cloudflare = cloudflare
  }

  return nitro as NitroConfig
}

function mergeCloudflareAgentStateNitroConfig(value: unknown, stateImport: string): NitroConfig {
  const nitro = cloneNitroConfig(value)
  configureCloudflareAgentState(nitro)
  installCloudflareAgentStateEntrypoint(nitro, { stateImport } as never)
  nitro.rollupConfig ||= {}
  nitro.rollupConfig.external = mergeCloudflareWorkersExternal(nitro.rollupConfig.external as RollupExternalOption | undefined)
  return nitro
}

function mergeNitroHandlers(nitro: NitroConfig, handlers: Array<{ handler: string, route: string }>): NitroConfig {
  if (handlers.length === 0) return nitro
  const existingHandlers = Array.isArray(nitro.handlers) ? nitro.handlers : []
  return {
    ...nitro,
    handlers: [...existingHandlers, ...handlers],
  }
}

function normalizeNitroRoute(route: string): string {
  const normalized = route.startsWith("/") ? route : `/${route}`
  return normalized.replace(/\[([^\]]+)\]/g, ":$1")
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function routeRegexSource(route: false | string | undefined, captureParams: string[] = []): string {
  if (!route) return "(?!)"
  const captured = new Set(captureParams)
  return `^${normalizeNitroRoute(route).split("/").map((part) => {
    if (!part.startsWith(":")) return escapeRegExp(part)
    const param = part.slice(1)
    return captured.has(param) ? `(?<${param}>[^/]+)` : "[^/]+"
  }).join("/")}$`
}

function routeUsesParam(route: false | string | undefined, param: string): boolean {
  return Boolean(route && normalizeNitroRoute(route).split("/").includes(`:${param}`))
}

function generatedWebhookRoute(route: false | string | undefined): string {
  return route ? normalizeNitroRoute(route) : ""
}

function isNetlifyHosting(config: ResolvedConfig): boolean {
  return resolveAgentHosting(config) === "netlify"
}

function resolveStringAliases(config: ResolvedConfig): Record<string, string> {
  const aliases: Record<string, string> = {}
  for (const alias of config.resolve.alias) {
    if (typeof alias.find === "string" && typeof alias.replacement === "string") {
      aliases[alias.find] = alias.replacement
    }
  }
  return aliases
}

function resolveWorkspaceSourceRoot(file: string): string {
  const workspaceDirectory = join(dirname(file), "workspace")
  return existsSync(workspaceDirectory) && statSync(workspaceDirectory).isDirectory()
    ? workspaceDirectory
    : dirname(file)
}

async function readColocatedAgentInstructions(handler: string): Promise<string | undefined> {
  const file = join(dirname(handler), "instructions.md")
  if (!existsSync(file) || !statSync(file).isFile()) return
  return await resolveInstructionImports(readFileSync(file, "utf8"), {
    file,
    read(specifier, importer) {
      const imported = resolve(dirname(importer), specifier)
      return {
        content: readFileSync(imported, "utf8"),
        file: imported,
      }
    },
  })
}

function generatedWorkspaceSourceRootHelper(name: string, workspaceDefinitionFromOptions: string): string[] {
  return [
    `function ${name}(agent, sourceRootDir, colocatedInstructions, colocatedSkills) {`,
    "  const skills = Object.fromEntries(Object.entries(colocatedSkills || {}).map(([key, source]) => {",
    "    const { encoding, content, ...options } = source",
    "    return [key, encoding === 'base64' ? { ...options, content: Uint8Array.from(atob(content), byte => byte.charCodeAt(0)) } : source]",
    "  }))",
    "  const resolvedAgent = Object.keys(skills).length ? Object.create(Object.getPrototypeOf(agent), Object.getOwnPropertyDescriptors(agent)) : agent",
    "  if (resolvedAgent !== agent) Object.defineProperty(resolvedAgent, Symbol.for('vitehub.agent.colocatedSkills'), { configurable: true, enumerable: true, value: skills })",
    "  const options = resolvedAgent?.__vitehubWorkspaceAgentOptions",
    "  const workspace = options?.workspace",
    "  if (!workspace || typeof workspace !== 'object' || 'name' in workspace) return resolvedAgent",
    "  const existingSources = resolvedAgent.sources && typeof resolvedAgent.sources === 'object' ? resolvedAgent.sources : undefined",
    "  const sources = colocatedInstructions",
    "    ? { __vitehubAgentInstructions: { content: colocatedInstructions, materialize: 'build', mount: '', workspacePath: 'AGENTS.md' }, ...workspace.sources, ...existingSources }",
    "    : { ...workspace.sources, ...existingSources }",
    "  const resolvedSources = Object.keys(sources).length ? sources : undefined",
    "  const resolvedSourceRootDir = workspace.sourceRootDir ?? resolvedAgent.sourceRootDir ?? sourceRootDir",
    "  const workspaceOptions = { ...options, workspace: { ...workspace, ...(resolvedSources ? { sources: resolvedSources } : {}), sourceRootDir: resolvedSourceRootDir } }",
    `  return { ...resolvedAgent, ...${workspaceDefinitionFromOptions}(workspaceOptions), __vitehubWorkspaceAgentOptions: workspaceOptions }`,
    "}",
  ]
}

function moduleImportSpecifier(fromFile: string, targetFile: string): string {
  const specifier = relative(dirname(fromFile), targetFile).replace(/\\/g, "/")
  return specifier.startsWith(".") ? specifier : `./${specifier}`
}

function generatedRuntimeHelpers(): string[] {
  return [
    "function waitUntilFromValue(value) {",
    "  return value && typeof value === 'object' && typeof value.waitUntil === 'function' ? value.waitUntil.bind(value) : undefined",
    "}",
    "",
    "function waitUntilFromEvent(event) {",
    "  return waitUntilFromValue(event)",
    "    || waitUntilFromValue(event.context)",
    "    || waitUntilFromValue(event.context?.cloudflare?.context)",
    "    || waitUntilFromValue(event.context?._platform?.cloudflare?.context)",
    "    || waitUntilFromValue(event.node?.req?.runtime?.cloudflare?.context)",
    "}",
    "",
    "function cloudflareFromEvent(event) {",
    "  const env = event.env || event.context?.cloudflare?.env || event.context?._platform?.cloudflare?.env || event.node?.req?.runtime?.cloudflare?.env",
    "  const context = event.context?.cloudflare?.context || event.context?._platform?.cloudflare?.context || event.node?.req?.runtime?.cloudflare?.context",
    "  return env && typeof env === 'object' ? { env, ...(context ? { context } : {}) } : undefined",
    "}",
  ]
}

function generatedCloudflareChatStateHelper(): string[] {
  return [
    "",
    "function chatStateFromCloudflare(cloudflare) {",
    `  const namespace = cloudflare?.env?.${defaultCloudflareAgentStateBinding}`,
    "  return namespace ? createCloudflareAgentState({ namespace }) : undefined",
    "}",
  ]
}

function generatedLibsqlChatStateHelper(state: GeneratedLibsqlAgentStateOptions): string[] {
  const { authTokenEnvName, durableUrlRequired, ephemeralHosting, ...stateOptions } = state
  const configuredAuthTokenOption = authTokenEnvName
    ? [`  ...(typeof process === 'object' && process.env[${JSON.stringify(authTokenEnvName)}] ? { authToken: process.env[${JSON.stringify(authTokenEnvName)}] } : {}),`]
    : []
  return [
    "",
    `const viteHubChatStateOptions = ${JSON.stringify(stateOptions)}`,
    "let viteHubChatState",
    "",
    "function chatStateFromLibsql() {",
    "  const runtimeUrl = typeof process === 'object' ? process.env.VITEHUB_AGENT_STATE_URL : undefined",
    "  const url = runtimeUrl || viteHubChatStateOptions.url",
    ...(durableUrlRequired
      ? ["  if (!url) throw new Error('[vitehub] Agent state requires a durable VITEHUB_AGENT_STATE_URL for this deployment. Configure agent.providers.state or set the environment variable.')"]
      : []),
    ...(ephemeralHosting
      ? [`  if (url?.startsWith('file:')) throw new Error(${JSON.stringify(`[vitehub] Agent state cannot use a file: URL on ${ephemeralHosting} because its filesystem is ephemeral. Configure a durable libSQL URL.`)})`]
      : []),
    "  if (!viteHubChatState) {",
    "    viteHubChatState = createLibsqlAgentState({",
    "      ...viteHubChatStateOptions,",
    ...configuredAuthTokenOption.map(line => `  ${line}`),
    "      ...(typeof process === 'object' && process.env.VITEHUB_AGENT_STATE_AUTH_TOKEN ? { authToken: process.env.VITEHUB_AGENT_STATE_AUTH_TOKEN } : {}),",
    "      ...(url ? { url } : {}),",
    "    })",
    "  }",
    "  return viteHubChatState",
    "}",
    "const viteHubChatStateResolver = () => chatStateFromLibsql()",
    "viteHubChatStateResolver.ownsScope = false",
  ]
}

function generatedNetlifyRuntimeHelpers(): string[] {
  return [
    "function waitUntilFromContext(context) {",
    "  return context && typeof context === 'object' && typeof context.waitUntil === 'function' ? context.waitUntil.bind(context) : undefined",
    "}",
    "",
    "function netlifyParam(context, name) {",
    "  const value = context?.params?.[name]",
    "  return typeof value === 'string' ? value : undefined",
    "}",
    "",
    "function ensureNetlifyHostingEnv() {",
    "  if (typeof process === 'object' && process && process.env && !process.env.VITEHUB_HOSTING) {",
    "    process.env.VITEHUB_HOSTING = 'netlify'",
    "  }",
    "}",
  ]
}

function generatedHostedWorkspaceRuntimeSetup(definitions: DiscoveredAgentDefinition[], workspaceImportBase: string): { imports: string[], setup: string[] } {
  const modules = definitions
    .map((definition, index) => definition.workspace ? `agent${index}` : undefined)
    .filter((module): module is string => Boolean(module))
  if (!modules.length) return { imports: [], setup: [] }
  return {
    imports: [
      `import { installHostedWorkspaceRuntime } from ${JSON.stringify(subpath(workspaceImportBase, "internal/runtime/hosted"))}`,
      `import { installHostedVercelBlobWorkspaceRuntime } from ${JSON.stringify(subpath(workspaceImportBase, "internal/runtime/hosted-vercel-blob"))}`,
    ],
    setup: [
      "function hasHostedWorkspaceStore(module) {",
      "  const agent = resolveAgentModule(module)",
      "  const store = agent?.__vitehubWorkspaceAgentOptions?.workspace?.store",
      "  return store && typeof store === 'object' && ['cloudflare-artifacts', 'github'].includes(store.provider)",
      "}",
      "",
      "function hasHostedVercelBlobWorkspaceStore(module) {",
      "  const agent = resolveAgentModule(module)",
      "  const workspace = agent?.__vitehubWorkspaceAgentOptions?.workspace",
      "  const store = workspace?.store",
      "  if (workspace && !store && typeof process === 'object' && process?.env?.BLOB_READ_WRITE_TOKEN) return true",
      "  return store && typeof store === 'object' && store.provider === 'vercel-blob'",
      "}",
      "",
      `if ([${modules.join(", ")}].some(hasHostedWorkspaceStore)) installHostedWorkspaceRuntime()`,
      `if ([${modules.join(", ")}].some(hasHostedVercelBlobWorkspaceStore)) installHostedVercelBlobWorkspaceRuntime()`,
      "",
    ],
  }
}

function generatedAgentIdentityEntries(definitions: DiscoveredAgentDefinition[]): string {
  return definitions
    .map(definition => `${JSON.stringify(definition.name)}: ${JSON.stringify({ name: definition.name, ...(definition.workspace ? { workspace: definition.workspace } : {}) })}`)
    .join(",\n  ")
}

interface GeneratedAgentDeploymentCatalog {
  imports: string[]
  setup: string[]
}

async function generateAgentDeploymentCatalog(
  definitions: DiscoveredAgentDefinition[],
  handlerPath: string,
  options: {
    agentImportBase: string
    channelHandlers?: boolean
    chatHandlers?: boolean
    workspaceImportBase: string
    workspaceRuntimeImport?: string
  },
): Promise<GeneratedAgentDeploymentCatalog> {
  const channelHandlers = options.channelHandlers !== false
  const chatHandlers = channelHandlers && options.chatHandlers !== false
  const entries = await Promise.all(definitions.map(async (definition, index) => {
    const moduleName = `agent${index}`
    const sourceRootDir = resolveWorkspaceSourceRoot(definition.handler)
    const colocatedInstructions = await readColocatedAgentInstructions(definition.handler)
    const colocatedSkills = readColocatedAgentSkills(definition.handler)
    const agentExpression = `withWorkspaceSourceRoot(resolveAgentModule(${moduleName}), ${JSON.stringify(sourceRootDir)}, ${JSON.stringify(colocatedInstructions)}, ${JSON.stringify(colocatedSkills)})`
    return {
      agentEntry: `${JSON.stringify(definition.name)}: ${agentExpression}`,
      import: `import * as ${moduleName} from ${JSON.stringify(moduleImportSpecifier(handlerPath, definition.handler))}`,
      moduleEntry: `${JSON.stringify(definition.name)}: ${moduleName}`,
      workspaceEntry: definition.workspace
        ? `workspaceRegistryEntry(${JSON.stringify(definition.workspace)}, ${moduleName}, ${JSON.stringify(sourceRootDir)}, ${JSON.stringify(colocatedInstructions)}, ${JSON.stringify(colocatedSkills)})`
        : undefined,
    }
  }))
  const hostedWorkspaceRuntime = generatedHostedWorkspaceRuntimeSetup(definitions, options.workspaceImportBase)
  const workspaceEntries = entries.flatMap(entry => entry.workspaceEntry ? [entry.workspaceEntry] : []).join(",\n  ")
  if (workspaceEntries && !options.workspaceRuntimeImport) {
    throw new TypeError("[vitehub] Agent deployment catalog requires a Workspace runtime import for Workspace Agents.")
  }
  const agentEntries = entries.map(entry => entry.agentEntry).join(",\n  ")
  const agentModuleEntries = entries.map(entry => entry.moduleEntry).join(",\n  ")
  const agentIdentityEntries = generatedAgentIdentityEntries(definitions)

  return {
    imports: [
      `import { workspaceAgentOwnsWorkspaceDefinition, workspaceDefinitionFromOptions } from ${JSON.stringify(options.agentImportBase)}`,
      ...(channelHandlers
        ? [`import { ${chatHandlers ? "createChannelChatRouteHandler, " : ""}createChannelWebhookRouteHandler${chatHandlers ? ", hasChannelChatRoute" : ""} } from ${JSON.stringify(subpath(options.agentImportBase, "server/internal"))}`]
        : []),
      ...(options.workspaceRuntimeImport ? [`import { setWorkspaceRuntimeRegistry } from ${JSON.stringify(options.workspaceRuntimeImport)}`] : []),
      ...hostedWorkspaceRuntime.imports,
      ...entries.map(entry => entry.import),
    ],
    setup: [
      "function resolveAgentModule(module) {",
      "  return module && typeof module === 'object' && 'default' in module ? module.default : module",
      "}",
      "",
      ...(chatHandlers
        ? [
            "function resolveChatRouteOptions(module) {",
            "  const chatRoute = module && typeof module === 'object' ? module.chatRoute : undefined",
            "  return chatRoute && typeof chatRoute === 'object' ? chatRoute : undefined",
            "}",
            "",
          ]
        : []),
      ...generatedWorkspaceSourceRootHelper("withWorkspaceSourceRoot", "workspaceDefinitionFromOptions"),
      "",
      "function workspaceRegistryEntry(name, module, sourceRootDir, colocatedInstructions, colocatedSkills) {",
      "  const agent = withWorkspaceSourceRoot(resolveAgentModule(module), sourceRootDir, colocatedInstructions, colocatedSkills)",
      "  if (!workspaceAgentOwnsWorkspaceDefinition(agent)) return",
      "  return [name, async () => ({ ...module, default: agent })]",
      "}",
      "",
      ...hostedWorkspaceRuntime.setup,
      ...(options.workspaceRuntimeImport
        ? [`setWorkspaceRuntimeRegistry(Object.fromEntries([${workspaceEntries ? `\n  ${workspaceEntries}\n` : ""}].filter(Boolean)))`, ""]
        : []),
      `const agents = {${agentEntries ? `\n  ${agentEntries}\n` : ""}}`,
      `const agentIdentities = {${agentIdentityEntries ? `\n  ${agentIdentityEntries}\n` : ""}}`,
      ...(channelHandlers
        ? [
            ...(chatHandlers
              ? [
                  `const agentModules = {${agentModuleEntries ? `\n  ${agentModuleEntries}\n` : ""}}`,
                  "const chatHandlers = Object.fromEntries(Object.entries(agents).filter(([, agent]) => hasChannelChatRoute(agent)).map(([name, agent]) => [name, createChannelChatRouteHandler(agent, resolveChatRouteOptions(agentModules[name]))]))",
                ]
              : ["const chatHandlers = {}"]),
            "const webhookHandlers = Object.fromEntries(Object.entries(agents).map(([name, agent]) => [name, createChannelWebhookRouteHandler(agent)]))",
          ]
        : []),
      "const agentNames = Object.keys(agents)",
    ],
  }
}

async function generateAgentWebhookRouteHandler(
  definitions: DiscoveredAgentDefinition[],
  handlerPath: string,
  options: { chatRoute?: false | string, cloudflareState?: boolean, libsqlState?: GeneratedLibsqlAgentStateOptions, runtime?: "vite", webhookRoute?: false | string } & AgentGeneratedImportOptions = {},
): Promise<string> {
  const agentImportBase = options.agentImportBase ?? agentPackageName
  const workspaceImportBase = options.workspaceImportBase ?? workspacePackageName
  const routeCapabilities = generatedAgentRouteCapabilities(options)
  const workflowRuntime = generatedAgentWorkflowRuntime(options, agentImportBase)
  const workspaceDependencyRuntime = generatedAgentWorkspaceDependencyRuntime(options, workspaceImportBase)
  const runtimeRouteOption = options.runtime === "vite" ? ", runtime: 'vite'" : ""
  const deploymentCatalog = await generateAgentDeploymentCatalog(definitions, handlerPath, {
    agentImportBase,
    chatHandlers: Boolean(options.chatRoute),
    workspaceImportBase,
    workspaceRuntimeImport: subpath(workspaceImportBase, "runtime"),
  })
  const webhookRoute = typeof options.webhookRoute === "string" ? options.webhookRoute : ""
  const webhookSelector = webhookRoute.includes("[webhook]") ? "getRouterParam(event, 'webhook')" : "''"
  const webhookStateOption = options.cloudflareState
    ? "state: chatStateFromCloudflare(cloudflare), webhookState: chatStateFromCloudflare(cloudflare), "
    : options.libsqlState
      ? "state: viteHubChatStateResolver, webhookState: viteHubChatStateResolver, "
      : ""

  return [
    ...deploymentCatalog.imports,
    ...(options.cloudflareState ? [`import { createCloudflareAgentState } from ${JSON.stringify(subpath(agentImportBase, "cloudflare"))}`] : []),
    ...(options.libsqlState ? [`import { createLibsqlAgentState } from ${JSON.stringify(subpath(agentImportBase, "state/sqlite"))}`] : []),
    ...workflowRuntime.imports,
    ...workspaceDependencyRuntime.imports,
    ...routeCapabilities.imports,
    "import { createError, defineEventHandler, getRequestHeaders, getRequestURL, getRouterParam, readRawBody } from 'h3'",
    "",
    ...workflowRuntime.setup,
    ...workspaceDependencyRuntime.setup,
    ...deploymentCatalog.setup,
    "async function toRequest(event) {",
    "  const body = await readRawBody(event)",
    "  return new Request(getRequestURL(event), {",
    "    body: body || undefined,",
    "    headers: getRequestHeaders(event),",
    "    method: event.method || 'POST',",
    "  })",
    "}",
    "",
    ...generatedRuntimeHelpers(),
    ...(options.cloudflareState ? generatedCloudflareChatStateHelper() : []),
    ...(options.libsqlState ? generatedLibsqlChatStateHelper(options.libsqlState) : []),
    "",
    ...routeCapabilities.setup,
    `const chatRoutePattern = new RegExp(${JSON.stringify(routeRegexSource(options.chatRoute))})`,
    `const webhookRoutePattern = new RegExp(${JSON.stringify(routeRegexSource(options.webhookRoute))})`,
    "",
    "export default defineEventHandler(async (event) => {",
    "  const pathname = getRequestURL(event).pathname",
    "  const isWebhookRoute = webhookRoutePattern.test(pathname)",
    "  const agent = getRouterParam(event, 'agent') || (agentNames.length === 1 ? agentNames[0] : undefined)",
    `  const webhook = ${webhookSelector}`,
    "  const handler = agent ? (isWebhookRoute ? webhookHandlers[agent] : chatHandlers[agent]) : undefined",
    "  if (!handler) {",
    "    throw createError({ statusCode: 404, statusMessage: 'Unknown ViteHub agent.' })",
    "  }",
    "  const cloudflare = cloudflareFromEvent(event)",
    `  return isWebhookRoute ? await handler(await toRequest(event), webhook, { agentIdentity: agentIdentities[agent], ${routeCapabilities.requestOption}cloudflare${runtimeRouteOption}, ${webhookStateOption}waitUntil: waitUntilFromEvent(event) }) : await handler(await toRequest(event), { agentIdentity: agentIdentities[agent], ${routeCapabilities.requestOption}cloudflare${runtimeRouteOption}, waitUntil: waitUntilFromEvent(event) })`,
    "})",
    "",
  ].join("\n")
}

async function generateAgentNetlifyFunctionRouteHandler(
  definitions: DiscoveredAgentDefinition[],
  handlerPath: string,
  options: { chatRoute?: false | string, discordGatewayRoute?: false | string, libsqlState?: GeneratedLibsqlAgentStateOptions, runtime?: "vite", webhookRoute?: false | string } & AgentGeneratedImportOptions = {},
): Promise<string> {
  const agentImportBase = options.agentImportBase ?? agentPackageName
  const workspaceImportBase = options.workspaceImportBase ?? workspacePackageName
  const routeCapabilities = generatedAgentRouteCapabilities(options)
  const workflowRuntime = generatedAgentWorkflowRuntime(options, agentImportBase)
  const workspaceDependencyRuntime = generatedAgentWorkspaceDependencyRuntime(options, workspaceImportBase)
  const runtimeRouteOption = options.runtime === "vite" ? ", runtime: 'vite'" : ""
  const deploymentCatalog = await generateAgentDeploymentCatalog(definitions, handlerPath, {
    agentImportBase,
    chatHandlers: Boolean(options.chatRoute),
    workspaceImportBase,
    workspaceRuntimeImport: subpath(agentImportBase, "server/workspace"),
  })
  const webhookSelector = routeUsesParam(options.webhookRoute, "webhook") ? "netlifyParam(context, 'webhook')" : "''"
  const webhookStateOption = options.libsqlState ? "state: viteHubChatStateResolver, webhookState: viteHubChatStateResolver, " : ""

  return [
    ...deploymentCatalog.imports,
    ...(options.libsqlState ? [`import { createLibsqlAgentState } from ${JSON.stringify(subpath(agentImportBase, "state/sqlite"))}`] : []),
    `import { createDiscordGatewayRouteHandler } from ${JSON.stringify(subpath(agentImportBase, "server/internal"))}`,
    ...workflowRuntime.imports,
    ...workspaceDependencyRuntime.imports,
    ...routeCapabilities.imports,
    "",
    ...workflowRuntime.setup,
    ...workspaceDependencyRuntime.setup,
    "function bearerToken(value) {",
    "  const match = /^Bearer\\s+(.+)$/i.exec(value || '')",
    "  return match?.[1]",
    "}",
    "",
    "function routePath(route, values) {",
    "  return route",
    "    .replace(/\\[([^\\]]+)\\]/g, (_, key) => encodeURIComponent(values[key] || ''))",
    "    .replace(/(^|\\/):([^/]+)/g, (_, prefix, key) => `${prefix}${encodeURIComponent(values[key] || '')}`)",
    "}",
    "",
    ...deploymentCatalog.setup,
    ...(options.libsqlState ? generatedLibsqlChatStateHelper(options.libsqlState) : []),
    ...generatedNetlifyRuntimeHelpers(),
    "",
    ...routeCapabilities.setup,
    "const discordGatewayHandlers = Object.fromEntries(Object.entries(agents).map(([name, agent]) => [name, createDiscordGatewayRouteHandler(agent)]))",
    `const webhookRoute = ${JSON.stringify(generatedWebhookRoute(options.webhookRoute))}`,
    `const defaultDiscordGatewayDurationMs = ${JSON.stringify(9 * 60 * 1000)}`,
    `const chatRoutePattern = new RegExp(${JSON.stringify(routeRegexSource(options.chatRoute))})`,
    `const webhookRoutePattern = new RegExp(${JSON.stringify(routeRegexSource(options.webhookRoute))})`,
    `const discordGatewayRoutePattern = new RegExp(${JSON.stringify(routeRegexSource(options.discordGatewayRoute))})`,
    "",
    "export default async function viteHubAgentNetlifyFunction(request, context) {",
    "  ensureNetlifyHostingEnv()",
    "  const pathname = new URL(request.url).pathname",
    "  const isChatRoute = chatRoutePattern.test(pathname)",
    "  const isDiscordGatewayRoute = discordGatewayRoutePattern.test(pathname)",
    "  const isWebhookRoute = webhookRoutePattern.test(pathname)",
    "  const agent = netlifyParam(context, 'agent') || (agentNames.length === 1 ? agentNames[0] : undefined)",
    `  const webhook = ${webhookSelector}`,
    "  const handler = agent ? (isDiscordGatewayRoute ? discordGatewayHandlers[agent] : isWebhookRoute ? webhookHandlers[agent] : isChatRoute ? chatHandlers[agent] : undefined) : undefined",
    "  if (!handler) {",
    "    return Response.json({ message: 'Unknown ViteHub agent.', status: 404 }, { status: 404 })",
    "  }",
    "  const waitUntil = waitUntilFromContext(context)",
    "  if (isDiscordGatewayRoute) {",
    "    const secret = process.env.VITEHUB_DISCORD_GATEWAY_SECRET",
    "    const localDevelopment = process.env.NODE_ENV === 'development'",
    "    if (!secret && !localDevelopment) {",
    "      return Response.json({ message: 'Discord Gateway route requires VITEHUB_DISCORD_GATEWAY_SECRET.', status: 500 }, { status: 500 })",
    "    }",
    "    if (secret && bearerToken(request.headers.get('authorization')) !== secret) {",
    "      return Response.json({ message: 'Unauthorized', status: 401 }, { status: 401 })",
    "    }",
    "    const requestUrl = new URL(request.url)",
    "    const durationMs = Number(process.env.VITEHUB_DISCORD_GATEWAY_DURATION_MS || '') || defaultDiscordGatewayDurationMs",
    "    const webhookUrl = process.env.VITEHUB_DISCORD_GATEWAY_WEBHOOK_URL || (webhookRoute ? (webhook) => `${requestUrl.origin}${routePath(webhookRoute, { agent, webhook })}` : undefined)",
    "    if (!webhookUrl) {",
    "      return Response.json({ message: 'Discord Gateway route requires an Agent webhook route.', status: 500 }, { status: 500 })",
    "    }",
    `    return await handler(request, { agentIdentity: agentIdentities[agent], ${routeCapabilities.requestOption}durationMs${runtimeRouteOption}, waitUntil, webhookUrl })`,
    "  }",
    `  return isWebhookRoute ? await handler(request, webhook, { agentIdentity: agentIdentities[agent]${runtimeRouteOption}, ${routeCapabilities.requestOption}${webhookStateOption}waitUntil }) : await handler(request, { agentIdentity: agentIdentities[agent]${runtimeRouteOption}, ${routeCapabilities.requestOption}waitUntil })`,
    "}",
    "",
  ].join("\n")
}

async function writeAgentWebhookRouteHandler(
  root: string,
  options: { chatRoute?: false | string, cloudflareState?: boolean, libsqlState?: GeneratedLibsqlAgentStateOptions, runtime?: "vite", webhookRoute?: false | string } & AgentGeneratedImportOptions = {},
): Promise<void> {
  const handlerPath = join(root, generatedAgentWebhookRouteHandler)
  const definitions = discoverAgentDefinitions({
    mode: "server-agents",
    scanDirs: [join(root, "server")],
  })
  await mkdir(dirname(handlerPath), { recursive: true })
  await writeFile(handlerPath, await generateAgentWebhookRouteHandler(definitions, handlerPath, options), "utf8")
}

async function generateAgentDiscordGatewayRouteHandler(
  definitions: DiscoveredAgentDefinition[],
  handlerPath: string,
  options: { discordGatewayRoute?: false | string, runtime?: "vite", webhookRoute?: false | string } & AgentGeneratedImportOptions = {},
): Promise<string> {
  const agentImportBase = options.agentImportBase ?? agentPackageName
  const workspaceImportBase = options.workspaceImportBase ?? workspacePackageName
  const routeCapabilities = generatedAgentRouteCapabilities(options)
  const workflowRuntime = generatedAgentWorkflowRuntime(options, agentImportBase)
  const workspaceDependencyRuntime = generatedAgentWorkspaceDependencyRuntime(options, workspaceImportBase)
  const runtimeRouteOption = options.runtime === "vite" ? ", runtime: 'vite'" : ""
  const deploymentCatalog = await generateAgentDeploymentCatalog(definitions, handlerPath, {
    agentImportBase,
    channelHandlers: false,
    workspaceImportBase,
    workspaceRuntimeImport: definitions.some(definition => definition.workspace)
      ? subpath(workspaceImportBase, "runtime")
      : undefined,
  })

  return [
    ...deploymentCatalog.imports,
    `import { createDiscordGatewayRouteHandler } from ${JSON.stringify(subpath(agentImportBase, "server"))}`,
    ...workflowRuntime.imports,
    ...workspaceDependencyRuntime.imports,
    ...routeCapabilities.imports,
    "import { createError, defineEventHandler, getRequestHeader, getRequestHeaders, getRequestURL, getRouterParam } from 'h3'",
    "",
    ...workflowRuntime.setup,
    ...workspaceDependencyRuntime.setup,
    ...deploymentCatalog.setup,
    ...generatedRuntimeHelpers(),
    "",
    "function bearerToken(value) {",
    "  const match = /^Bearer\\s+(.+)$/i.exec(value || '')",
    "  return match?.[1]",
    "}",
    "",
    "function runtimeEnvValue(cloudflare, key) {",
    "  return cloudflare?.env?.[key] ?? (typeof process === 'object' ? process.env[key] : undefined)",
    "}",
    "",
    "function routePath(route, values) {",
    "  return route",
    "    .replace(/\\[([^\\]]+)\\]/g, (_, key) => encodeURIComponent(values[key] || ''))",
    "    .replace(/(^|\\/):([^/]+)/g, (_, prefix, key) => `${prefix}${encodeURIComponent(values[key] || '')}`)",
    "}",
    "",
    ...routeCapabilities.setup,
    `const webhookRoute = ${JSON.stringify(generatedWebhookRoute(options.webhookRoute))}`,
    `const defaultDurationMs = ${JSON.stringify(9 * 60 * 1000)}`,
    "const handlers = Object.fromEntries(Object.entries(agents).map(([name, agent]) => [name, createDiscordGatewayRouteHandler(agent)]))",
    "",
    "export default defineEventHandler(async (event) => {",
    "  const cloudflare = cloudflareFromEvent(event)",
    "  const secret = runtimeEnvValue(cloudflare, 'VITEHUB_DISCORD_GATEWAY_SECRET')",
    "  const localDevelopment = typeof process === 'object' && process.env.NODE_ENV === 'development'",
    "  if (!secret && !localDevelopment) {",
    "    throw createError({ statusCode: 500, statusMessage: 'Discord Gateway route requires VITEHUB_DISCORD_GATEWAY_SECRET.' })",
    "  }",
    "  if (secret && bearerToken(getRequestHeader(event, 'authorization')) !== secret) {",
    "    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })",
    "  }",
    "  const agent = getRouterParam(event, 'agent') || (agentNames.length === 1 ? agentNames[0] : undefined)",
    "  const handler = agent ? handlers[agent] : undefined",
    "  if (!handler) {",
    "    throw createError({ statusCode: 404, statusMessage: 'Unknown ViteHub agent.' })",
    "  }",
    "  const requestUrl = getRequestURL(event)",
    "  const durationMs = Number(runtimeEnvValue(cloudflare, 'VITEHUB_DISCORD_GATEWAY_DURATION_MS') || '') || defaultDurationMs",
    "  const webhookUrl = runtimeEnvValue(cloudflare, 'VITEHUB_DISCORD_GATEWAY_WEBHOOK_URL') || (webhookRoute ? (webhook) => `${requestUrl.origin}${routePath(webhookRoute, { agent, webhook })}` : undefined)",
    "  if (!webhookUrl) {",
    "    throw createError({ statusCode: 500, statusMessage: 'Discord Gateway route requires an Agent webhook route.' })",
    "  }",
    `  return await handler(new Request(requestUrl, { method: event.method || 'GET', headers: getRequestHeaders(event) }), { agentIdentity: agentIdentities[agent], ${routeCapabilities.requestOption}cloudflare, durationMs${runtimeRouteOption}, waitUntil: waitUntilFromEvent(event), webhookUrl })`,
    "})",
    "",
  ].join("\n")
}

async function writeAgentDiscordGatewayRouteHandler(
  root: string,
  options: { discordGatewayRoute?: false | string, runtime?: "vite", webhookRoute?: false | string } & AgentGeneratedImportOptions = {},
): Promise<void> {
  const handlerPath = join(root, generatedAgentDiscordGatewayRouteHandler)
  const definitions = discoverAgentDefinitions({
    mode: "server-agents",
    scanDirs: [join(root, "server")],
  })
  await mkdir(dirname(handlerPath), { recursive: true })
  await writeFile(handlerPath, await generateAgentDiscordGatewayRouteHandler(definitions, handlerPath, options), "utf8")
}

async function generateAgentDenoServer(
  definitions: DiscoveredAgentDefinition[],
  handlerPath: string,
  options: { chatRoute?: false | string, libsqlState?: GeneratedLibsqlAgentStateOptions, webhookRoute?: false | string } & AgentGeneratedImportOptions = {},
): Promise<string> {
  const agentImportBase = options.agentImportBase ?? agentPackageName
  const workspaceImportBase = options.workspaceImportBase ?? workspacePackageName
  const routeCapabilities = generatedAgentRouteCapabilities(options)
  const workflowRuntime = generatedAgentWorkflowRuntime(options, agentImportBase)
  const workspaceDependencyRuntime = generatedAgentWorkspaceDependencyRuntime(options, workspaceImportBase)
  const deploymentCatalog = await generateAgentDeploymentCatalog(definitions, handlerPath, {
    agentImportBase,
    chatHandlers: Boolean(options.chatRoute),
    workspaceImportBase,
    workspaceRuntimeImport: definitions.some(definition => definition.workspace)
      ? subpath(workspaceImportBase, "runtime")
      : undefined,
  })

  return [
    ...deploymentCatalog.imports,
    ...(options.libsqlState ? [`import { createLibsqlAgentState } from ${JSON.stringify(subpath(agentImportBase, "state/sqlite"))}`] : []),
    ...workflowRuntime.imports,
    ...workspaceDependencyRuntime.imports,
    ...routeCapabilities.imports,
    "",
    ...workflowRuntime.setup,
    ...workspaceDependencyRuntime.setup,
    "await import('../schedule/deno-cron.mjs').catch((error) => {",
    "  if (error instanceof TypeError && String(error.message).includes('deno-cron.mjs')) return",
    "  throw error",
    "})",
    "",
    ...deploymentCatalog.setup,
    ...(options.libsqlState ? generatedLibsqlChatStateHelper(options.libsqlState) : []),
    ...routeCapabilities.setup,
    "function jsonError(status, message) {",
    "  return Response.json({ error: true, status, statusText: message, message }, { status })",
    "}",
    "",
    "function readDenoArg(args, index, name) {",
    "  const arg = args[index]",
    "  if (arg === name) return { index: index + 1, value: args[index + 1] }",
    "  if (arg.startsWith(`${name}=`)) return { index, value: arg.slice(name.length + 1) }",
    "}",
    "",
    "function resolveDenoServeOptions(args) {",
    "  const options = {}",
    "  for (let index = 0; index < args.length; index += 1) {",
    "    const hostArg = readDenoArg(args, index, '--host') || readDenoArg(args, index, '--hostname')",
    "    if (hostArg) {",
    "      if (hostArg.value) options.hostname = hostArg.value",
    "      index = hostArg.index",
    "      continue",
    "    }",
    "    const portArg = readDenoArg(args, index, '--port')",
    "    if (portArg) {",
    "      const port = Number(portArg.value)",
    "      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('[vitehub] Deno Provider Output expected --port to be a valid TCP port.')",
    "      options.port = port",
    "      index = portArg.index",
    "    }",
    "  }",
    "  return Object.keys(options).length ? options : undefined",
    "}",
    "",
    `const chatRoutePattern = new RegExp(${JSON.stringify(routeRegexSource(options.chatRoute, ["agent"]))})`,
    `const webhookRoutePattern = new RegExp(${JSON.stringify(routeRegexSource(options.webhookRoute, ["agent", "webhook"]))})`,
    "",
    "async function handleRequest(request) {",
    "  const pathname = new URL(request.url).pathname",
    "  const chatMatch = chatRoutePattern.exec(pathname)",
    "  const webhookMatch = webhookRoutePattern.exec(pathname)",
    "  const isWebhookRoute = Boolean(webhookMatch)",
    "  const groups = (webhookMatch || chatMatch)?.groups || {}",
    "  const agent = groups.agent || (agentNames.length === 1 ? agentNames[0] : undefined)",
    "  const webhook = groups.webhook || ''",
    "  const handler = agent ? (isWebhookRoute ? webhookHandlers[agent] : chatHandlers[agent]) : undefined",
    "  if (!handler || (!chatMatch && !webhookMatch)) return jsonError(404, 'Unknown ViteHub agent route.')",
    `  return isWebhookRoute ? await handler(request, webhook, { agentIdentity: agentIdentities[agent]${routeCapabilities.requestProperty}${options.libsqlState ? ", state: viteHubChatStateResolver, webhookState: viteHubChatStateResolver" : ""} }) : await handler(request, { agentIdentity: agentIdentities[agent]${routeCapabilities.requestProperty}${options.libsqlState ? ", state: viteHubChatStateResolver" : ""} })`,
    "}",
    "",
    "const serveOptions = resolveDenoServeOptions(Deno.args)",
    "if (serveOptions) {",
    "  Deno.serve(serveOptions, handleRequest)",
    "}",
    "else {",
    "  Deno.serve(handleRequest)",
    "}",
    "",
  ].join("\n")
}

async function writeAgentDenoServer(
  root: string,
  options: { chatRoute?: false | string, libsqlState?: GeneratedLibsqlAgentStateOptions, webhookRoute?: false | string } & AgentGeneratedImportOptions = {},
): Promise<void> {
  const handlerPath = join(root, generatedAgentDenoServer)
  const definitions = discoverAgentDefinitions({
    mode: "server-agents",
    scanDirs: [join(root, "server")],
  })
  const scheduleRegistryImport = options.schedule
    ? moduleImportSpecifier(handlerPath, await writeStandaloneAgentScheduleRegistry(
        root,
        definitions,
        options.agentImportBase ?? agentPackageName,
        options.runtimeCapabilities,
        options.scheduleRuntimeImport,
        options,
      ))
    : undefined
  await mkdir(dirname(handlerPath), { recursive: true })
  await writeFile(handlerPath, await generateAgentDenoServer(definitions, handlerPath, {
    ...options,
    scheduleRegistryImport,
  }), "utf8")
}

async function writeAgentNetlifyFunctionRouteHandler(
  root: string,
  options: { chatRoute?: false | string, discordGatewayRoute?: false | string, libsqlState?: GeneratedLibsqlAgentStateOptions, runtime?: "vite", webhookRoute?: false | string } & AgentGeneratedImportOptions = {},
): Promise<string> {
  const handlerPath = join(root, generatedAgentNetlifyFunction)
  const definitions = discoverAgentDefinitions({
    mode: "server-agents",
    scanDirs: [join(root, "server")],
  })
  const scheduleRegistryImport = options.schedule
    ? moduleImportSpecifier(handlerPath, await writeStandaloneAgentScheduleRegistry(
        root,
        definitions,
        options.agentImportBase ?? agentPackageName,
        options.runtimeCapabilities,
        options.scheduleRuntimeImport,
        options,
      ))
    : undefined
  await mkdir(dirname(handlerPath), { recursive: true })
  await writeFile(handlerPath, await generateAgentNetlifyFunctionRouteHandler(definitions, handlerPath, {
    ...options,
    scheduleRegistryImport,
  }), "utf8")
  return handlerPath
}

function createNetlifyAgentFunctionConfig(options: { chatRoute?: false | string, discordGatewayRoute?: false | string, webhookRoute?: false | string }): object {
  const paths = [
    options.chatRoute ? normalizeNitroRoute(options.chatRoute) : undefined,
    options.webhookRoute ? normalizeNitroRoute(options.webhookRoute) : undefined,
    options.discordGatewayRoute ? normalizeNitroRoute(options.discordGatewayRoute) : undefined,
  ].filter((path): path is string => Boolean(path))

  return {
    path: paths.length === 1 ? paths[0] : paths,
    name: netlifyAgentFunctionName,
    nodeBundler: "esbuild",
  }
}

async function writeNetlifyAgentProviderOutput(
  config: ResolvedConfig,
  options: ResolvedAgentModuleOptions,
  generatedOptions: AgentGeneratedImportOptions & { libsqlState?: GeneratedLibsqlAgentStateOptions, runtime?: "vite" } = {},
): Promise<void> {
  const handlerPath = await writeAgentNetlifyFunctionRouteHandler(config.root, {
    ...generatedOptions,
    chatRoute: options.routes.chat,
    discordGatewayRoute: options.routes.discordGateway,
    libsqlState: generatedOptions.libsqlState ?? resolveLibsqlAgentState(options, config),
    webhookRoute: options.routes.webhooks,
  })
  await writeProviderDeploymentOutputs({
    clientOutDir: config.build?.outDir ?? "dist",
    netlify: {
      functions: [{
        bundleEntry: handlerPath,
        bundleOptions: {
          alias: {
            ...resolveStringAliases(config),
            ...generatedOptions.providerImportAliases,
          },
          external: resolveNetlifyAgentBundleExternals(generatedOptions),
          format: "esm",
          platform: "node",
        },
        config: createNetlifyAgentFunctionConfig({
          chatRoute: options.routes.chat,
          discordGatewayRoute: options.routes.discordGateway,
          webhookRoute: options.routes.webhooks,
        }),
        functionName: netlifyAgentFunctionName,
      }],
    },
    rootDir: config.root,
  })
}

async function cleanupNetlifyAgentProviderOutput(config: ResolvedConfig): Promise<void> {
  await writeProviderDeploymentOutputs({
    clientOutDir: config.build?.outDir ?? "dist",
    cleanup: {
      netlify: {
        functionNames: [netlifyAgentFunctionName],
      },
    },
    rootDir: config.root,
  })
}

export function hubAgent(options?: AgentModuleOptions): AgentVitePlugin {
  const frameworkOptions = getInternalAgentOptions(options)
  let agent: AgentModuleOptions | false | undefined = options
  let runtimeCapabilities: GeneratedAgentRuntimeCapability[] = []
  let standaloneRuntimeCapabilities: GeneratedAgentRuntimeCapability[] = []
  let resolved: ResolvedConfig | undefined

  async function writeGeneratedAgentOutputs(config: ResolvedConfig) {
    const normalized = normalizeAgentOptions(agent)
    const schedule = hasScheduleVitePlugin(config)
    const hasHostedAgents = hasHostedAgentDefinitions(config.root)
    if (normalized && hasHostedAgents) {
      if (normalized.runtime === "deno") {
        await writeAgentDenoServer(config.root, {
          agentImportBase: getAgentImportBase(agent, frameworkOptions),
          chatRoute: normalized.routes.chat,
          libsqlState: resolveLibsqlAgentState(normalized, config),
          runtimeCapabilities: standaloneRuntimeCapabilities,
          schedule,
          scheduleRuntimeImport: getScheduleRuntimeImport(agent, frameworkOptions),
          workflowImportBase: getWorkflowImportBase(agent, frameworkOptions),
          workspaceDependencyRuntimeImports: getWorkspaceDependencyRuntimeImports(agent, frameworkOptions),
          workspaceImportBase: getWorkspaceImportBase(agent, frameworkOptions),
          webhookRoute: normalized.routes.webhooks,
        })
      }
      else {
        await writeAgentWebhookRouteHandler(config.root, {
          agentImportBase: getAgentImportBase(agent, frameworkOptions),
          chatRoute: normalized.routes.chat,
          cloudflareState: shouldInstallCloudflareAgentState(normalized, config),
          libsqlState: resolveLibsqlAgentState(normalized, config),
          ...(config.command === "serve" ? { runtime: "vite" as const } : {}),
          runtimeCapabilities,
          schedule,
          scheduleRuntimeImport: getScheduleRuntimeImport(agent, frameworkOptions),
          workflowImportBase: getWorkflowImportBase(agent, frameworkOptions),
          workspaceDependencyRuntimeImports: getWorkspaceDependencyRuntimeImports(agent, frameworkOptions),
          workspaceImportBase: getWorkspaceImportBase(agent, frameworkOptions),
          webhookRoute: normalized.routes.webhooks,
        })
        if (normalized.routes.discordGateway) {
          await writeAgentDiscordGatewayRouteHandler(config.root, {
            agentImportBase: getAgentImportBase(agent, frameworkOptions),
            discordGatewayRoute: normalized.routes.discordGateway,
            ...(config.command === "serve" ? { runtime: "vite" as const } : {}),
            runtimeCapabilities,
            schedule,
            scheduleRuntimeImport: getScheduleRuntimeImport(agent, frameworkOptions),
            workflowImportBase: getWorkflowImportBase(agent, frameworkOptions),
            workspaceDependencyRuntimeImports: getWorkspaceDependencyRuntimeImports(agent, frameworkOptions),
            workspaceImportBase: getWorkspaceImportBase(agent, frameworkOptions),
            webhookRoute: normalized.routes.webhooks,
          })
        }
        if (config.command === "serve" && isNetlifyHosting(config)) {
          await writeNetlifyAgentProviderOutput(config, normalized, {
            agentImportBase: getAgentImportBase(agent, frameworkOptions),
            libsqlState: resolveLibsqlAgentState(normalized, config),
            providerImportAliases: getProviderImportAliases(agent, frameworkOptions),
            runtime: "vite",
            runtimeCapabilities: standaloneRuntimeCapabilities,
            schedule,
            scheduleRuntimeImport: getScheduleRuntimeImport(agent, frameworkOptions),
            workflowImportBase: getWorkflowImportBase(agent, frameworkOptions),
            workspaceDependencyRuntimeImports: getWorkspaceDependencyRuntimeImports(agent, frameworkOptions),
            workspaceImportBase: getWorkspaceImportBase(agent, frameworkOptions),
          })
        }
      }
    }
    else if (config.command === "serve" && isNetlifyHosting(config)) {
      await cleanupNetlifyAgentProviderOutput(config)
    }
  }

  return {
    name: "@vite-hub/agent/vite",
    async configureServer(server) {
      if (agent !== false) {
        await registerAgentInvocationStreamEndpoint(server)
      }
    },
    async handleHotUpdate(context) {
      const file = context.file.replace(/\\/g, "/")
      if (!/\.agent\.(?:c|m)?[jt]s$/i.test(file) && !/\/server\/agents\/.*(?:\.(?:c|m)?[jt]s|\/skills\/.*)$/i.test(file)) return
      const skillUpdate = /\/server\/agents\/.*\/skills\/.*$/i.test(file)
      if (resolved && skillUpdate) {
        await writeGeneratedAgentOutputs(resolved)
      }
      const moduleIds = [resolvedScheduleRegistryId, resolvedScheduleTargetsId]
      if (resolved?.root) {
        moduleIds.push(join(resolved.root, generatedScheduleRuntimeRegistrySuffix).replace(/\\/g, "/"))
        if (skillUpdate) {
          const root = resolved.root
          moduleIds.push(...[
            generatedAgentDenoServer,
            generatedAgentDiscordGatewayRouteHandler,
            generatedAgentNetlifyFunction,
            generatedAgentWebhookRouteHandler,
          ].map(handler => join(root, handler).replace(/\\/g, "/")))
        }
      }
      for (const id of moduleIds) {
        const module = context.server.moduleGraph.getModuleById(id)
        if (module) context.server.moduleGraph.invalidateModule(module)
      }
    },
    async transform(code, id) {
      if (agent === false || !resolved?.root) return
      if (!isScheduleRegistryId(id) && id !== resolvedScheduleTargetsId) return
      const definitions = discoverScheduledAgentDefinitions(resolved.root)
      return isScheduleRegistryId(id)
        ? await transformScheduleRegistry(
            code,
            definitions,
            getAgentImportBase(agent, frameworkOptions),
            undefined,
            runtimeCapabilities,
            getScheduleRuntimeImport(agent, frameworkOptions),
            {
              workflowImportBase: getWorkflowImportBase(agent, frameworkOptions),
              workspaceDependencyRuntimeImports: getWorkspaceDependencyRuntimeImports(agent, frameworkOptions),
              workspaceImportBase: getWorkspaceImportBase(agent, frameworkOptions),
            },
          )
        : transformScheduleTargets(code, definitions)
    },
    vitehub: {
      cli: async () => {
        const { createAgentCliContributor } = await import(/* @vite-ignore */ "./cli.js")
        if (agent === false || agent?.cli === false) return createAgentCliContributor(false)
        return createAgentCliContributor({ eval: resolveAgentEvalOptions(agent?.eval) })
      },
    },
    config(config) {
      agent = config.agent ?? agent
      const resolved = normalizeAgentOptions(agent)
      const hasHostedAgents = Boolean(resolved && hasHostedAgentDefinitions(resolve(config.root || process.cwd())))
      const denoOutput = resolved && resolved.runtime === "deno"
      const installCloudflareState = hasHostedAgents && !denoOutput && shouldInstallCloudflareAgentState(resolved, config)
      const nitroHandlers = [
        ...(resolved && hasHostedAgents && !denoOutput && resolved.routes.chat
          ? [{
              handler: generatedAgentWebhookRouteHandler,
              route: normalizeNitroRoute(resolved.routes.chat),
            }]
          : []),
        ...(resolved && hasHostedAgents && !denoOutput
          ? [{
              handler: generatedAgentWebhookRouteHandler,
              route: normalizeNitroRoute(resolved.routes.webhooks),
            }]
          : []),
        ...(resolved && hasHostedAgents && !denoOutput && resolved.routes.discordGateway
          ? [{
              handler: generatedAgentDiscordGatewayRouteHandler,
              route: normalizeNitroRoute(resolved.routes.discordGateway),
            }]
          : []),
      ]
      const nitro = installCloudflareState
        ? mergeCloudflareAgentStateNitroConfig(
            (config as { nitro?: unknown }).nitro,
            getCloudflareStateImport(agent, frameworkOptions),
          )
        : cloneNitroConfig((config as { nitro?: unknown }).nitro)
      const mergedNitro = mergeNitroHandlers(nitro, nitroHandlers)
      return {
        ...(typeof agent !== "undefined" ? { agent } : {}),
        ...(nitroHandlers.length
          ? {
              build: mergeBuildExternal(config as BuildWithRolldownOptions, optionalMessageAdapterRuntimeExternals),
            }
          : {}),
        ...(nitroHandlers.length || installCloudflareState
          ? {
              nitro: mergedNitro,
            }
          : {}),
        server: {
          watch: {
            ignored: mergeGeneratedViteHubWatchIgnored(config.server?.watch?.ignored),
          },
        },
      }
    },
    async configResolved(config) {
      resolved = config
      agent = config.agent ?? agent
      runtimeCapabilities = await resolveGeneratedAgentRuntimeCapabilities(
        config,
        getInternalAgentOptions(agent)?.runtimeCapabilityImports ?? frameworkOptions?.runtimeCapabilityImports,
      )
      standaloneRuntimeCapabilities = await writeStandaloneAgentRuntimeCapabilities(config, runtimeCapabilities)
      await writeGeneratedAgentOutputs(config)
      if (agent === false || agent?.eval === false) {
        return
      }

      const evalOptions = resolveAgentEvalOptions(agent?.eval)
      if (evalOptions === false) {
        return
      }
      await writeAgentEvaliteConfig(config.root, evalOptions)
    },
    configEnvironment(name, config) {
      if (!isServerEnvironment(name, config)) {
        return
      }

      return {
        resolve: {
          noExternal: mergeNoExternal(config.resolve?.noExternal),
        },
      }
    },
    closeBundle: {
      order: "post",
      async handler() {
        if (!resolved || resolved.command !== "build") return
        const normalized = normalizeAgentOptions(agent)
        if (normalized && normalized.runtime === "deno") return
        if (normalized && hasHostedAgentDefinitions(resolved.root) && isNetlifyHosting(resolved)) {
          await writeNetlifyAgentProviderOutput(resolved, normalized, {
            agentImportBase: getAgentImportBase(agent, frameworkOptions),
            libsqlState: resolveLibsqlAgentState(normalized, resolved),
            providerImportAliases: getProviderImportAliases(agent, frameworkOptions),
            runtimeCapabilities: standaloneRuntimeCapabilities,
            schedule: hasScheduleVitePlugin(resolved),
            scheduleRuntimeImport: getScheduleRuntimeImport(agent, frameworkOptions),
            workflowImportBase: getWorkflowImportBase(agent, frameworkOptions),
            workspaceDependencyRuntimeImports: getWorkspaceDependencyRuntimeImports(agent, frameworkOptions),
            workspaceImportBase: getWorkspaceImportBase(agent, frameworkOptions),
          })
        } else if (isNetlifyHosting(resolved)) {
          await cleanupNetlifyAgentProviderOutput(resolved)
        }
        await copyVercelFunctionRuntimePackages({
          packages: [{ includePeerDependencies: true, name: "@ai-sdk/mcp", optional: true }],
          rootDir: resolved.root,
        })
      },
    },
  }
}

declare module "vite" {
  interface UserConfig {
    agent?: false | AgentModuleOptions
  }
}
