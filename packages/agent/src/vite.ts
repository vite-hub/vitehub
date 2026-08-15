import { existsSync, statSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { writeProviderDeploymentOutputs } from "@vite-hub/internal/build/deployment-output"
import { copyVercelFunctionRuntimePackages } from "@vite-hub/internal/build/vercel-runtime-packages"
import { createNoExternalMerger, hasNitroConfigContext, isServerEnvironment, mergeGeneratedViteHubWatchIgnored, resolveViteHubGeneratedRoot, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { getHostingProvider } from "@vite-hub/internal/hosting"
import { markdownTemplateMaterializationPath } from "@vite-hub/markdown-template/vite"

import { registerAgentInvocationStreamEndpoint } from "./vite/invocation-stream-endpoint.ts"
import {
  configureCloudflareAgentState,
  defaultCloudflareAgentStateBinding,
  installCloudflareAgentStateEntrypoint,
} from "./cloudflare.ts"
import { normalizeAgentOptions } from "./config.ts"
import { discoverAgentDefinitions, discoverAgentEvalFiles } from "./discovery.ts"
import { removeAgentEvaliteConfig, resolveAgentEvalOptions, writeAgentEvaliteConfig } from "./internal/evalite-config.ts"
import { isPortableAgentWorkflowCapability } from "./internal/final-channel-output.ts"
import { agentRouteUsesParam, defaultAgentChatRoute, normalizeAgentRoute } from "./internal/routes.ts"
import { readColocatedAgentHome } from "./vite/colocated-agent-home.ts"
import { readColocatedAgentInstructions } from "./vite/colocated-agent-instructions.ts"
import { readColocatedAgentSkills } from "./vite/colocated-agent-skills.ts"

import type { Plugin, ResolvedConfig } from "vite"
import type { CloudflareAgentStateMigration, CloudflareAgentStateRollupTarget, CloudflareAgentStateTarget } from "./cloudflare.ts"
import type { AgentModuleOptions, DiscoveredAgentDefinition, ResolvedAgentModuleOptions } from "./types.ts"

interface AgentCliContributingPlugin {
  vitehub?: {
    agent?: {
      transformWorkflowRegistry: (code: string, id: string) => string
    }
    cli?: unknown
  }
}

export type AgentVitePlugin = Plugin & AgentCliContributingPlugin

const agentPackageName = "@vite-hub/agent"
const mergeNoExternal = createNoExternalMerger(agentPackageName)
const generatedAgentDenoServer = "agent/deno-server.ts"
const generatedAgentDiscordGatewayRouteHandler = "agent/discord-gateway-route.ts"
const generatedAgentDiscordGatewayPlugin = "agent/discord-gateway-plugin.ts"
const generatedAgentWebhookRouteHandler = "agent/chat-webhook-route.ts"
const generatedAgentWebhookQueuePlugin = "agent/webhook-queue-plugin.ts"
const generatedAgentNetlifyFunction = "agent/netlify-function.mjs"
const generatedAgentEmailRuntime = "agent/email-runtime.js"
const generatedAgentScheduleRegistry = "agent/schedule-registry.js"
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
const nitroAgentRuntimeInlines = ["vite-hub", agentPackageName, "@ai-sdk/mcp"]
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
  processDiscordGateway?: boolean
  providerImportAliases?: Record<string, string>
  runtimeCapabilityImports?: Record<string, false | string>
  scheduleRuntimeImport?: string
  workflowImportBase?: string
  workspaceDependencyRuntimeImports?: WorkspaceDependencyRuntimeImports
  workspaceImportBase?: string
}

interface AgentGeneratedImportOptions {
  agentImportBase?: string
  denoCronImport?: string
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
  packageName: false | string
  pluginName: string
}

const generatedAgentRuntimeCapabilityDefinitions: GeneratedAgentRuntimeCapability[] = [
  { importName: "blob", name: "blob", packageName: "@vite-hub/blob", pluginName: "@vite-hub/blob/vite" },
  { importName: "agentDb", name: "db", packageName: "@vite-hub/database/drizzle", pluginName: "@vite-hub/database/vite" },
  { importName: "email", name: "email", packageName: "@vite-hub/email/server", pluginName: "@vite-hub/email/vite" },
  { importName: "kv", name: "kv", packageName: "@vite-hub/kv", pluginName: "@vite-hub/kv/vite" },
]

function configuredGeneratedAgentRuntimeCapabilities(
  plugins: readonly Plugin[],
  packageImports: Record<string, false | string> = {},
): GeneratedAgentRuntimeCapability[] {
  const pluginNames = new Set(plugins.map(plugin => plugin.name))
  return generatedAgentRuntimeCapabilityDefinitions
    .filter(capability => pluginNames.has(capability.pluginName) || packageImports[capability.name] === false)
    .map(capability => ({
      ...capability,
      packageName: packageImports[capability.name] === false && pluginNames.has(capability.pluginName)
        ? capability.packageName
        : packageImports[capability.name] ?? capability.packageName,
    }))
}

async function resolveGeneratedAgentRuntimeCapabilities(
  config: Pick<ResolvedConfig, "plugins" | "root"> & Partial<Pick<ResolvedConfig, "createResolver">>,
  packageImports: Record<string, false | string> = {},
): Promise<GeneratedAgentRuntimeCapability[]> {
  const candidates = configuredGeneratedAgentRuntimeCapabilities(config.plugins || [], packageImports)
  const resolveImport = config.createResolver?.()
  if (!resolveImport) return candidates
  const importer = join(resolveViteHubGeneratedRoot(config), "agent", "runtime-capabilities.js")
  const resolved = await Promise.all(candidates.map(async (capability) => {
    const importName = capability.packageName
    if (importName === false) return { ...capability, packageName: importName }
    return await resolveImport(importName, importer)
      ? { ...capability, packageName: importName }
      : undefined
  }))
  return resolved.filter((capability): capability is GeneratedAgentRuntimeCapability => capability !== undefined)
}

function generatedAgentRuntimeCapabilityAlias(capability: GeneratedAgentRuntimeCapability): string {
  return `vitehub${capability.name[0]!.toUpperCase()}${capability.name.slice(1)}`
}

function generatedAgentRuntimeCapabilityImports(capabilities: GeneratedAgentRuntimeCapability[]): string[] {
  return capabilities.flatMap(capability => capability.packageName === false
    ? []
    : [`import { ${capability.importName} as ${generatedAgentRuntimeCapabilityAlias(capability)} } from ${JSON.stringify(capability.packageName)}`])
}

function generatedAgentRuntimeCapabilities(capabilities: GeneratedAgentRuntimeCapability[], schedule: boolean): string {
  const entries = capabilities.map(capability =>
    `${capability.name}: ${capability.packageName === false ? "false" : generatedAgentRuntimeCapabilityAlias(capability)}`
  )
  if (schedule) entries.push("schedule: { schedules: vitehubSchedules }")
  return `{ ${entries.join(", ")} }`
}

async function writeStandaloneAgentRuntimeCapabilities(
  config: Pick<ResolvedConfig, "plugins" | "root">,
  capabilities: GeneratedAgentRuntimeCapability[],
): Promise<GeneratedAgentRuntimeCapability[]> {
  const standaloneCapabilities = capabilities.filter(capability => capability.name !== "db")
  const emailCapability = standaloneCapabilities.find(capability =>
    capability.name === "email" && capability.packageName !== false
  )
  const emailPlugin = config.plugins?.find(plugin => plugin.name === "@vite-hub/email/vite") as Plugin & {
    api?: { getDefinition?: () => { handler: string } | undefined }
  }
  const definition = emailPlugin?.api?.getDefinition?.()
  const runtimePath = join(resolveViteHubGeneratedRoot(config), generatedAgentEmailRuntime)
  if (!emailCapability || !definition) {
    await rm(runtimePath, { force: true })
    return standaloneCapabilities
  }

  const emailPackageName = emailCapability.packageName
  if (emailPackageName === false) return standaloneCapabilities
  const emailImport = emailPackageName.endsWith("/server")
    ? emailPackageName.slice(0, -"/server".length)
    : "@vite-hub/email"
  await mkdir(dirname(runtimePath), { recursive: true })
  await writeFile(runtimePath, [
    `import { createEmail } from ${JSON.stringify(emailImport)}`,
    `import definition from ${JSON.stringify(moduleImportSpecifier(runtimePath, definition.handler))}`,
    "export const email = createEmail(definition)",
    "",
  ].join("\n"), "utf8")
  return standaloneCapabilities.map(capability => capability === emailCapability
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

function generatedAgentWorkflowCapabilityLoaders(
  capabilities: GeneratedAgentRuntimeCapability[],
  agentImportBase: string,
  includeCapabilityImports = true,
) {
  const portableCapabilities = capabilities.filter(capability =>
    capability.packageName !== false && isPortableAgentWorkflowCapability(capability.name),
  )
  if (!portableCapabilities.length) return { imports: [] as string[], setup: [] as string[] }
  return {
    imports: [
      ...(includeCapabilityImports ? generatedAgentRuntimeCapabilityImports(portableCapabilities) : []),
      `import { setAgentWorkflowCapabilityLoaders as vitehubSetAgentWorkflowCapabilityLoaders } from ${JSON.stringify(subpath(agentImportBase, "server/internal"))}`,
    ],
    setup: [
      "vitehubSetAgentWorkflowCapabilityLoaders({",
      ...portableCapabilities.map(capability => `  ${capability.name}: () => ${generatedAgentRuntimeCapabilityAlias(capability)},`),
      "})",
      "",
    ],
  }
}

function transformGeneratedAgentWorkflowRegistry(
  code: string,
  capabilities: GeneratedAgentRuntimeCapability[],
  agentImportBase: string,
  state: { cloudflare?: boolean, libsql?: GeneratedLibsqlAgentStateOptions } = {},
): string {
  const capabilityLoaders = generatedAgentWorkflowCapabilityLoaders(capabilities, agentImportBase)
  const stateImports = state.libsql
    ? [
        `import { createLibsqlAgentState } from ${JSON.stringify(subpath(agentImportBase, "state/sqlite"))}`,
        `import { setAgentChannelDeliveryWorkflowStateResolver } from ${JSON.stringify(subpath(agentImportBase, "server/internal"))}`,
      ]
    : state.cloudflare
      ? [
          `import { createCloudflareAgentState, getActiveCloudflareEnv } from ${JSON.stringify(subpath(agentImportBase, "cloudflare"))}`,
          `import { setAgentChannelDeliveryWorkflowStateResolver } from ${JSON.stringify(subpath(agentImportBase, "server/internal"))}`,
        ]
      : []
  const stateSetup = state.libsql
    ? [
        ...generatedLibsqlChatStateHelper(state.libsql),
        "setAgentChannelDeliveryWorkflowStateResolver(() => ({ state: viteHubChatStateResolver }))",
        "",
      ]
    : state.cloudflare
      ? [
          `setAgentChannelDeliveryWorkflowStateResolver(context => {`,
          `  const namespace = (context.cloudflare?.env || getActiveCloudflareEnv())?.${defaultCloudflareAgentStateBinding}`,
          "  return namespace ? { state: createCloudflareAgentState({ namespace }) } : {}",
          "})",
          "",
        ]
      : []
  if (!capabilityLoaders.imports.length && !stateImports.length) return code
  return [...capabilityLoaders.imports, ...stateImports, "", ...capabilityLoaders.setup, ...stateSetup, code].join("\n")
}

function isGeneratedAgentWorkflowRegistryId(id: string): boolean {
  const normalizedId = id.replaceAll("\\", "/")
  return normalizedId.includes("/.vitehub/") && normalizedId.endsWith("/workflow/registry.mjs")
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
  const workflowCapabilityLoaders = generatedAgentWorkflowCapabilityLoaders(
    runtimeCapabilities,
    options.agentImportBase ?? agentPackageName,
    false,
  )
  return {
    imports: [
      ...generatedAgentRuntimeCapabilityImports(runtimeCapabilities),
      ...workflowCapabilityLoaders.imports,
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
      ...workflowCapabilityLoaders.setup,
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

function discoverScheduledAgentDefinitions(root: string, serverDirs = [join(root, "server")]): DiscoveredAgentDefinition[] {
  const definitions = [
    ...discoverAgentDefinitions({ mode: "vite-suffix", rootDir: root }),
    ...discoverAgentDefinitions({ mode: "server-agents", scanDirs: serverDirs }),
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

async function isColocatedAgentInstructionDependency(root: string, file: string, serverDirs?: string[]): Promise<boolean> {
  const target = resolve(file)
  for (const definition of discoverScheduledAgentDefinitions(root, serverDirs)) {
    const dependencies = new Set<string>()
    await readColocatedAgentInstructions(definition.handler, { dependencies })
    if (dependencies.has(target)) return true
  }
  return false
}

function hasHostedAgentDefinitions(root: string, serverDirs = [join(root, "server")]): boolean {
  return discoverAgentDefinitions({
    mode: "server-agents",
    scanDirs: serverDirs,
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
    const colocatedInstructions = await readColocatedAgentInstructions(definition.handler)
    const colocatedHome = readColocatedAgentHome(definition.handler)
    return [
      `if (Object.prototype.hasOwnProperty.call(registry, ${JSON.stringify(`agent/${definition.name}`)})) throw new Error(${JSON.stringify(`[vitehub] Duplicate Runtime Schedule target: agent/${definition.name}`)})`,
      `registry[${JSON.stringify(`agent/${definition.name}`)}] = async () => {`,
      `  const module = await import(${JSON.stringify(handlerImport)})`,
      `  return vitehubDefineScheduledAgentTarget(vitehubAgentWithColocatedHome(vitehubWithWorkspaceSourceRoot(vitehubAgentWithColocatedInstructions(vitehubResolveScheduledAgentModule(module), ${JSON.stringify(colocatedInstructions)}), ${JSON.stringify(sourceRootDir)}, ${JSON.stringify(colocatedInstructions)}, ${JSON.stringify(readColocatedAgentSkills(definition.handler))}), ${JSON.stringify(colocatedHome)}), { agentIdentity: ${JSON.stringify(agentIdentity)}, capabilities: ${generatedAgentRuntimeCapabilities(runtimeCapabilities, true)} })`,
      "}",
    ]
  }))).flat()
  const workflowRuntime = generatedAgentWorkflowRuntime(generatedImportOptions, agentImportBase)
  const workspaceRuntime = generatedAgentWorkspaceDependencyRuntime(
    generatedImportOptions,
    generatedImportOptions.workspaceImportBase ?? workspacePackageName,
  )
  return [
    `import { agentWithColocatedInstructions as vitehubAgentWithColocatedInstructions, workspaceDefinitionFromOptions as vitehubWorkspaceDefinitionFromOptions } from ${JSON.stringify(agentImportBase)}`,
    `import { agentWithColocatedHome as vitehubAgentWithColocatedHome } from ${JSON.stringify(subpath(agentImportBase, "runtime/workflow"))}`,
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

const defaultLocalAgentStateUrl = "file:.vitehub/data/agent-state.sqlite"

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
  command?: "build" | "serve",
): options is ResolvedAgentModuleOptions {
  if (!options) return false
  const { provider, url } = options.providers.state
  if (provider === "cloudflare" || provider === "cloudflare-agents") return true
  if (provider !== "auto") return false
  if (url) return false
  if (options.runtime === "cloudflare-agents") return true
  if (command === "serve" || (isRecord(config) && config.command === "serve")) return false
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

function mergeAgentNitroExternals(value: unknown): NitroConfig {
  const nitro = cloneNitroConfig(value)
  const externals = isRecord(nitro.externals) ? { ...nitro.externals } : {}
  const existingInline = Array.isArray(externals.inline) ? externals.inline : []
  externals.inline = externals.inline === true
    ? true
    : [...new Set([...existingInline, ...nitroAgentRuntimeInlines])]
  nitro.externals = externals
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

function mergeNitroPlugins(nitro: NitroConfig, plugins: string[]): NitroConfig {
  if (plugins.length === 0) return nitro
  const existingPlugins = Array.isArray(nitro.plugins) ? nitro.plugins : []
  return { ...nitro, plugins: [...existingPlugins, ...plugins] }
}

function normalizeNitroRoute(route: string): string {
  return normalizeAgentRoute(route)
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
  return agentRouteUsesParam(route, param)
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

function generatedWorkspaceSourceRootHelper(name: string, workspaceDefinitionFromOptions: string, typescript = false): string[] {
  const parameters = typescript
    ? "<Agent extends AgentInput>(agent: Agent, sourceRootDir: string, colocatedInstructions: string | undefined, colocatedSkills: ViteHubEncodedColocatedSkills | undefined): Agent"
    : "(agent, sourceRootDir, colocatedInstructions, colocatedSkills)"
  return [
    `function ${name}${parameters} {`,
    "  const skills = Object.fromEntries(Object.entries(colocatedSkills || {}).map(([key, source]) => {",
    "    const { encoding, content, ...options } = source",
    "    return [key, encoding === 'base64' ? { ...options, content: Uint8Array.from(atob(content), byte => byte.charCodeAt(0)) } : source]",
    "  }))",
    `  const resolvedAgent = ${typescript ? "(" : ""}Object.keys(skills).length ? Object.create(Object.getPrototypeOf(agent), Object.getOwnPropertyDescriptors(agent)) : agent${typescript ? ") as Agent & Partial<WorkspaceAgentDefinition>" : ""}`,
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
    `  const workspaceOptions = { ...options, workspace: { ...workspace, ...(resolvedSources ? { sources: resolvedSources } : {}), sourceRootDir: resolvedSourceRootDir } }${typescript ? " as WorkspaceAgentOptions" : ""}`,
    `  const decoratedAgent = { ...resolvedAgent, ...${workspaceDefinitionFromOptions}(workspaceOptions), __vitehubWorkspaceAgentOptions: workspaceOptions }`,
    "  for (const key of Reflect.ownKeys(resolvedAgent)) {",
    `    if (!Object.prototype.propertyIsEnumerable.call(resolvedAgent, key)) Object.defineProperty(decoratedAgent, key, Object.getOwnPropertyDescriptor(resolvedAgent, key)${typescript ? "!" : ""})`,
    "  }",
    `  return decoratedAgent${typescript ? " as unknown as Agent" : ""}`,
    "}",
  ]
}

function moduleImportSpecifier(fromFile: string, targetFile: string): string {
  const specifier = relative(dirname(fromFile), targetFile).replace(/\\/g, "/")
  return specifier.startsWith(".") ? specifier : `./${specifier}`
}

interface PositionedNode {
  end: number
  start: number
  type: string
  [key: string]: unknown
}

function isPositionedNode(value: unknown): value is PositionedNode {
  return Boolean(
    value
    && typeof value === "object"
    && typeof (value as PositionedNode).type === "string"
    && typeof (value as PositionedNode).start === "number"
    && typeof (value as PositionedNode).end === "number",
  )
}

function visitNodes(node: PositionedNode, visit: (node: PositionedNode, parent?: PositionedNode) => void, parent?: PositionedNode): void {
  visit(node, parent)
  for (const value of Object.values(node)) {
    if (isPositionedNode(value)) visitNodes(value, visit, node)
    else if (Array.isArray(value)) {
      for (const item of value) {
        if (isPositionedNode(item)) visitNodes(item, visit, node)
      }
    }
  }
}

function applyCodeReplacements(
  code: string,
  replacements: Array<{ end: number, start: number, value: string }>,
): string {
  let transformed = code
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    transformed = transformed.slice(0, replacement.start) + replacement.value + transformed.slice(replacement.end)
  }
  return transformed
}

function addBindingIdentifiers(value: unknown, bindings: Set<string>): void {
  if (!isPositionedNode(value)) return
  if (value.type === "Identifier" && typeof value.name === "string") {
    bindings.add(value.name)
    return
  }
  if (value.type === "Property") {
    addBindingIdentifiers(value.value, bindings)
    return
  }
  if (value.type === "RestElement") {
    addBindingIdentifiers(value.argument, bindings)
    return
  }
  if (value.type === "AssignmentPattern") {
    addBindingIdentifiers(value.left, bindings)
    return
  }
  for (const item of Array.isArray(value.elements) ? value.elements : []) addBindingIdentifiers(item, bindings)
  for (const property of Array.isArray(value.properties) ? value.properties : []) addBindingIdentifiers(property, bindings)
}

function scopedBindings(node: PositionedNode): Set<string> {
  const bindings = new Set<string>()
  if (node.type.includes("Function")) {
    addBindingIdentifiers(node.id, bindings)
    for (const parameter of Array.isArray(node.params) ? node.params : []) addBindingIdentifiers(parameter, bindings)
  }
  if (node.type === "CatchClause") addBindingIdentifiers(node.param, bindings)
  if (node.type === "Program" || node.type === "BlockStatement") {
    for (const statement of Array.isArray(node.body) ? node.body : []) {
      if (!isPositionedNode(statement)) continue
      if (statement.type === "VariableDeclaration") {
        for (const declaration of Array.isArray(statement.declarations) ? statement.declarations : []) {
          if (isPositionedNode(declaration)) addBindingIdentifiers(declaration.id, bindings)
        }
      }
      else if (statement.type === "FunctionDeclaration" || statement.type === "ClassDeclaration") {
        addBindingIdentifiers(statement.id, bindings)
      }
    }
  }
  return bindings
}

function visitScopedNodes(
  node: PositionedNode,
  shadows: ReadonlySet<string>,
  visit: (node: PositionedNode, shadows: ReadonlySet<string>) => void,
): void {
  const bindings = scopedBindings(node)
  const nestedShadows = bindings.size ? new Set([...shadows, ...bindings]) : shadows
  visit(node, nestedShadows)
  for (const value of Object.values(node)) {
    if (isPositionedNode(value)) visitScopedNodes(value, nestedShadows, visit)
    else if (Array.isArray(value)) {
      for (const item of value) {
        if (isPositionedNode(item)) visitScopedNodes(item, nestedShadows, visit)
      }
    }
  }
}

export function transformRepositoryHostContextMaterialization(
  code: string,
  parse: (code: string) => unknown,
): string | undefined {
  const program = parse(code)
  if (!isPositionedNode(program)) return
  const replacements: Array<{ end: number, start: number, value: string }> = []
  const imports: string[] = []
  const identifiers = new Set<string>()
  const namedImports = new Set<string>()
  const namespaceImports = new Set<string>()
  let importPosition: number | undefined

  visitNodes(program, (node) => {
    if (node.type === "Identifier" && typeof node.name === "string") identifiers.add(node.name)
    if (node.type !== "ImportDeclaration") return
    const source = node.source
    if (
      !isPositionedNode(source)
      || source.type !== "Literal"
      || source.value !== "@vite-hub/agent/capabilities"
      && source.value !== "vite-hub/agent/capabilities"
    ) return
    importPosition = Math.min(importPosition ?? node.start, node.start)
    const specifiers = Array.isArray(node.specifiers) ? node.specifiers : []
    for (const specifier of specifiers) {
      if (!isPositionedNode(specifier)) continue
      const local = specifier.local
      if (!isPositionedNode(local) || local.type !== "Identifier" || typeof local.name !== "string") continue
      if (specifier.type === "ImportNamespaceSpecifier") namespaceImports.add(local.name)
      const imported = specifier.imported
      if (
        specifier.type === "ImportSpecifier"
        && isPositionedNode(imported)
        && imported.type === "Identifier"
        && imported.name === "repositoryHostContext"
      ) namedImports.add(local.name)
    }
  })
  if (!namedImports.size && !namespaceImports.size) return

  visitScopedNodes(program, new Set(), (node, shadows) => {
    if (node.type !== "CallExpression") return
    const callee = node.callee
    const namedCall = isPositionedNode(callee)
      && callee.type === "Identifier"
      && typeof callee.name === "string"
      && namedImports.has(callee.name)
      && !shadows.has(callee.name)
    const memberCall = isPositionedNode(callee)
      && callee.type === "MemberExpression"
      && callee.computed !== true
      && isPositionedNode(callee.object)
      && callee.object.type === "Identifier"
      && typeof callee.object.name === "string"
      && namespaceImports.has(callee.object.name)
      && !shadows.has(callee.object.name)
      && isPositionedNode(callee.property)
      && callee.property.type === "Identifier"
      && callee.property.name === "repositoryHostContext"
    if (!namedCall && !memberCall) return
    const argument = Array.isArray(node.arguments) ? node.arguments[0] : undefined
    if (!isPositionedNode(argument) || argument.type !== "ObjectExpression") return
    const properties = Array.isArray(argument.properties) ? argument.properties : []
    for (const property of properties) {
      if (!isPositionedNode(property) || property.type !== "Property" || property.computed === true) continue
      const key = property.key
      const name = isPositionedNode(key) && key.type === "Identifier"
        ? key.name
        : isPositionedNode(key) && key.type === "Literal"
          ? key.value
          : undefined
      const value = property.value
      if (name !== "materialize" || !isPositionedNode(value) || value.type !== "Literal" || typeof value.value !== "string") continue
      let templateName = `__vitehubRepositoryHostContextTemplate${imports.length}`
      while (identifiers.has(templateName)) templateName += "_"
      identifiers.add(templateName)
      const path = markdownTemplateMaterializationPath(value.value)
      imports.push(`import ${templateName} from ${JSON.stringify(value.value)};`)
      replacements.push({
        end: value.end,
        start: value.start,
        value: `{ path: ${JSON.stringify(path)}, template: ${templateName} }`,
      })
    }
  })

  if (!replacements.length) return
  replacements.push({
    end: importPosition!,
    start: importPosition!,
    value: `${imports.join("\n")}\n`,
  })
  return applyCodeReplacements(code, replacements)
}

interface EveExtensionImport {
  call: PositionedNode
  declaration: PositionedNode
  identity?: string
  local: string
  source: string
}

function nodePropertyName(node: PositionedNode): unknown {
  const key = node.key
  return isPositionedNode(key) && key.type === "Identifier"
    ? key.name
    : isPositionedNode(key) && key.type === "Literal"
      ? key.value
      : undefined
}

function unwrapTypeScriptExpression(node: PositionedNode): PositionedNode {
  let expression = node
  while (
    expression.type === "TSAsExpression"
    || expression.type === "TSSatisfiesExpression"
    || expression.type === "TSNonNullExpression"
  ) {
    const inner = expression.expression
    if (!isPositionedNode(inner)) break
    expression = inner
  }
  return expression
}

function staticObjectProperty(
  object: PositionedNode,
  name: string,
  objects: Map<string, PositionedNode>,
  seen = new Set<PositionedNode>(),
): PositionedNode | null | undefined {
  if (seen.has(object)) return
  seen.add(object)
  const properties = Array.isArray(object.properties) ? object.properties : []
  for (let index = properties.length - 1; index >= 0; index--) {
    const property = properties[index]
    if (!isPositionedNode(property)) continue
    if (property.type === "Property" && property.computed !== true && nodePropertyName(property) === name) return property
    if (property.type !== "SpreadElement") continue
    const argument = property.argument
    if (!isPositionedNode(argument) || argument.type !== "Identifier" || typeof argument.name !== "string") return null
    const spread = objects.get(argument.name)
    if (!spread) return null
    const found = staticObjectProperty(spread, name, objects, seen)
    if (found !== undefined) return found
  }
}

function eveExtensionIdentityNamespace(specifier: string): string {
  const encoded = [...specifier].map((character) => {
    if (/[a-z0-9-]/i.test(character)) return character
    if (character === "_") return "_u"
    if (character === "@") return "_a"
    if (character === "/") return "_s"
    return `_x${character.codePointAt(0)!.toString(16)}_`
  }).join("")
  return `pkg-${encoded}`
}

export async function transformEveExtensionCapabilities(
  code: string,
  parse: (code: string) => unknown,
  resolveExtension: (specifier: string) => Promise<boolean | string>,
  agentImportBase: string = agentPackageName,
  resolveExtensionIdentity: (specifier: string) => Promise<boolean | string> = resolveExtension,
): Promise<string | undefined> {
  const program = parse(code)
  if (!isPositionedNode(program)) return

  const imports = new Map<string, { declaration: PositionedNode, source: string }>()
  const defineAgentImports = new Set<string>()
  const defineAgentNamespaces = new Set<string>()
  const staticArrays = new Map<string, PositionedNode>()
  const staticObjects = new Map<string, PositionedNode>()
  const exportedStaticArrays = new Set<PositionedNode>()
  const references = new Map<string, number>()
  const functionRanges: Array<{ end: number, start: number }> = []
  const nestedClassRanges: Array<{ end: number, start: number }> = []
  const shadowRanges = new Map<string, Array<{ end: number, start: number }>>()
  for (const statement of Array.isArray(program.body) ? program.body : []) {
    if (!isPositionedNode(statement)) continue
    const declarationStatement = statement.type === "ExportNamedDeclaration" && isPositionedNode(statement.declaration)
      ? statement.declaration
      : statement
    if (declarationStatement.type !== "VariableDeclaration" || declarationStatement.kind !== "const") continue
    for (const declaration of Array.isArray(declarationStatement.declarations) ? declarationStatement.declarations : []) {
      if (!isPositionedNode(declaration) || declaration.type !== "VariableDeclarator") continue
      const identifier = declaration.id
      const initializer = isPositionedNode(declaration.init) ? unwrapTypeScriptExpression(declaration.init) : declaration.init
      if (!isPositionedNode(identifier) || identifier.type !== "Identifier" || typeof identifier.name !== "string") continue
      if (!isPositionedNode(initializer)) continue
      if (initializer.type === "ArrayExpression") {
        staticArrays.set(identifier.name, initializer)
        if (statement.type === "ExportNamedDeclaration" && identifier.name === "capabilities") exportedStaticArrays.add(initializer)
      }
      if (initializer.type === "ObjectExpression") staticObjects.set(identifier.name, initializer)
    }
  }
  for (const statement of Array.isArray(program.body) ? program.body : []) {
    if (!isPositionedNode(statement)) continue
    if (statement.type === "ExportNamedDeclaration") {
      for (const specifier of Array.isArray(statement.specifiers) ? statement.specifiers : []) {
        if (!isPositionedNode(specifier)) continue
        const local = specifier.local
        if (!isPositionedNode(local) || local.type !== "Identifier" || typeof local.name !== "string") continue
        const exported = specifier.exported
        const exportedName = isPositionedNode(exported) && exported.type === "Identifier"
          ? exported.name
          : isPositionedNode(exported) && exported.type === "Literal"
            ? exported.value
            : undefined
        if (exportedName !== "capabilities") continue
        const array = staticArrays.get(local.name)
        if (array) exportedStaticArrays.add(array)
      }
    }
  }
  visitNodes(program, (node, parent) => {
    const nonComputedPropertyKey = parent?.type === "Property"
      && parent.computed !== true
      && parent.shorthand !== true
      && parent.key === node
    const nonComputedMemberProperty = parent?.type === "MemberExpression"
      && parent.computed !== true
      && parent.property === node
    if (node.type === "Identifier" && typeof node.name === "string" && !nonComputedPropertyKey && !nonComputedMemberProperty) {
      references.set(node.name, (references.get(node.name) ?? 0) + 1)
    }
    if (node.type.includes("Function")) functionRanges.push({ end: node.end, start: node.start })
    if (node.type === "PropertyDefinition" || node.type === "StaticBlock") nestedClassRanges.push({ end: node.end, start: node.start })
    if (node.type !== "ImportDeclaration") return
    const source = node.source
    const specifiers = Array.isArray(node.specifiers) ? node.specifiers : []
    if (!isPositionedNode(source) || source.type !== "Literal" || typeof source.value !== "string") return
    if (source.value === "@vite-hub/agent" || source.value === "vite-hub/agent") {
      for (const specifier of specifiers) {
        if (!isPositionedNode(specifier)) continue
        if (specifier.type === "ImportNamespaceSpecifier") {
          const local = specifier.local
          if (isPositionedNode(local) && local.type === "Identifier" && typeof local.name === "string") {
            defineAgentNamespaces.add(local.name)
          }
          continue
        }
        if (specifier.type !== "ImportSpecifier") continue
        const imported = specifier.imported
        const local = specifier.local
        if (
          isPositionedNode(imported)
          && imported.type === "Identifier"
          && imported.name === "defineAgent"
          && isPositionedNode(local)
          && local.type === "Identifier"
          && typeof local.name === "string"
        ) defineAgentImports.add(local.name)
      }
    }
    const defaultSpecifier = specifiers.find(specifier => isPositionedNode(specifier) && specifier.type === "ImportDefaultSpecifier")
    if (!isPositionedNode(defaultSpecifier)) return
    const local = defaultSpecifier.local
    if (!isPositionedNode(local) || local.type !== "Identifier" || typeof local.name !== "string") return
    imports.set(local.name, { declaration: node, source: source.value })
  })
  if (!imports.size) return

  const shadowable = new Set([
    ...imports.keys(),
    ...defineAgentImports,
    ...defineAgentNamespaces,
    ...staticArrays.keys(),
    ...staticObjects.keys(),
  ])
  const bindingNames = (value: unknown): string[] => {
    if (!isPositionedNode(value)) return []
    if (value.type === "Identifier" && typeof value.name === "string") return [value.name]
    if (value.type === "RestElement") return bindingNames(value.argument)
    if (value.type === "AssignmentPattern") return bindingNames(value.left)
    if (value.type === "ArrayPattern") return (Array.isArray(value.elements) ? value.elements : []).flatMap(bindingNames)
    if (value.type === "ObjectPattern") {
      return (Array.isArray(value.properties) ? value.properties : []).flatMap((property) => {
        if (!isPositionedNode(property)) return []
        return property.type === "RestElement" ? bindingNames(property.argument) : bindingNames(property.value)
      })
    }
    return []
  }
  const recordShadows = (value: unknown, range?: { end: number, start: number }): void => {
    if (!range) return
    for (const name of bindingNames(value)) {
      if (!shadowable.has(name)) continue
      const ranges = shadowRanges.get(name) ?? []
      ranges.push(range)
      shadowRanges.set(name, ranges)
    }
  }
  const collectShadows = (
    value: unknown,
    scope?: { end: number, start: number },
    functionScope?: { end: number, start: number },
  ): void => {
    if (!value || typeof value !== "object") return
    const node = value as Record<string, unknown>
    const nextScope = isPositionedNode(node) && (
      node.type === "BlockStatement"
      || node.type === "CatchClause"
      || node.type === "ForStatement"
      || node.type === "ForInStatement"
      || node.type === "ForOfStatement"
      || node.type === "StaticBlock"
      || node.type === "SwitchStatement"
      || node.type.includes("Function")
    )
      ? { end: node.end, start: node.start }
      : scope
    const nextFunctionScope = isPositionedNode(node) && node.type.includes("Function")
      ? { end: node.end, start: node.start }
      : functionScope
    if (node.type === "VariableDeclaration") {
      const declarationScope = node.kind === "var" ? nextFunctionScope ?? nextScope : nextScope
      for (const declaration of Array.isArray(node.declarations) ? node.declarations : []) {
        if (isPositionedNode(declaration) && declaration.type === "VariableDeclarator") {
          recordShadows(declaration.id, declarationScope)
        }
      }
    }
    if (nextScope && typeof node.type === "string" && node.type.includes("Function")) {
      for (const parameter of Array.isArray(node.params) ? node.params : []) {
        recordShadows(parameter, nextScope)
      }
    }
    if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") recordShadows(node.id, scope)
    if (node.type === "FunctionExpression" || node.type === "ClassExpression") recordShadows(node.id, nextScope)
    if (node.type === "CatchClause") recordShadows(node.param, nextScope)
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) child.forEach(item => collectShadows(item, nextScope, nextFunctionScope))
      else collectShadows(child, nextScope, nextFunctionScope)
    }
  }
  collectShadows(program)

  const calls: EveExtensionImport[] = []
  const collectedArrays = new Set<PositionedNode>()
  function collectExtensionCalls(array: PositionedNode): void {
    if (collectedArrays.has(array)) return
    collectedArrays.add(array)
    for (const rawElement of Array.isArray(array.elements) ? array.elements : []) {
      if (!isPositionedNode(rawElement)) continue
      const element = unwrapTypeScriptExpression(rawElement)
      if (element.type === "SpreadElement") {
        const argument = element.argument
        if (isPositionedNode(argument) && argument.type === "Identifier" && typeof argument.name === "string") {
          if (shadowRanges.get(argument.name)?.some(range => argument.start > range.start && argument.end < range.end)) continue
          const spreadArray = staticArrays.get(argument.name)
          if (spreadArray) collectExtensionCalls(spreadArray)
        }
        continue
      }
      if (element.type !== "CallExpression") continue
      const rawCallee = element.callee
      if (!isPositionedNode(rawCallee)) continue
      const callee = unwrapTypeScriptExpression(rawCallee)
      if (!isPositionedNode(callee) || callee.type !== "Identifier" || typeof callee.name !== "string") continue
      const imported = imports.get(callee.name)
      if (!imported) continue
      if (shadowRanges.get(callee.name)?.some(range => element.start > range.start && element.end < range.end)) continue
      calls.push({ call: element, declaration: imported.declaration, local: callee.name, source: imported.source })
    }
  }
  visitNodes(program, (node) => {
    if (node.type !== "CallExpression") return
    const callee = node.callee
    const isDefineAgentCall = isPositionedNode(callee)
      && (
        (callee.type === "Identifier" && typeof callee.name === "string" && defineAgentImports.has(callee.name)
          && !shadowRanges.get(callee.name)?.some(range => node.start > range.start && node.end < range.end))
        || (
          callee.type === "MemberExpression"
          && callee.computed !== true
          && isPositionedNode(callee.object)
          && callee.object.type === "Identifier"
          && typeof callee.object.name === "string"
          && defineAgentNamespaces.has(callee.object.name)
          && !shadowRanges.get(callee.object.name)?.some(range => node.start > range.start && node.end < range.end)
          && isPositionedNode(callee.property)
          && callee.property.type === "Identifier"
          && callee.property.name === "defineAgent"
        )
      )
    if (!isDefineAgentCall) return
    const rawOptions = Array.isArray(node.arguments) ? node.arguments[0] : undefined
    if (!isPositionedNode(rawOptions)) return
    const unwrappedOptions = unwrapTypeScriptExpression(rawOptions)
    const options = unwrappedOptions.type === "ObjectExpression"
      ? unwrappedOptions
      : unwrappedOptions.type === "Identifier" && typeof unwrappedOptions.name === "string"
        && !shadowRanges.get(unwrappedOptions.name)?.some(range => node.start > range.start && node.end < range.end)
          ? staticObjects.get(unwrappedOptions.name)
        : undefined
    if (!options) return
    const capabilities = staticObjectProperty(options, "capabilities", staticObjects)
    if (!isPositionedNode(capabilities)) return
    const rawValue = capabilities.value
    if (!isPositionedNode(rawValue)) return
    const value = unwrapTypeScriptExpression(rawValue)
    const array = value.type === "ArrayExpression"
      ? value
      : value.type === "Identifier" && typeof value.name === "string"
        && !shadowRanges.get(value.name)?.some(range => value.start > range.start && value.end < range.end)
          ? staticArrays.get(value.name)
        : undefined
    if (!array) return
    collectExtensionCalls(array)
  })
  for (const array of exportedStaticArrays) collectExtensionCalls(array)
  if (!calls.length) return

  const extensions: EveExtensionImport[] = []
  for (const call of calls) {
    const resolvedIdentity = await resolveExtension(call.source)
    if (!resolvedIdentity) continue
    if ([...functionRanges, ...nestedClassRanges].some(range => call.call.start > range.start && call.call.end < range.end)) {
      throw new Error(`[vitehub] Eve extension ${JSON.stringify(call.source)} must be mounted in a top-level static capabilities array.`)
    }
    const args = Array.isArray(call.call.arguments) ? call.call.arguments : []
    if (args.length > 1 || args.some(argument => isPositionedNode(argument) && argument.type === "SpreadElement")) {
      throw new Error(`[vitehub] Eve extension ${JSON.stringify(call.source)} accepts one config argument.`)
    }
    extensions.push({ ...call, identity: typeof resolvedIdentity === "string" ? resolvedIdentity : call.source })
  }
  if (!extensions.length) return

  const packageCounts = new Map<string, number>()
  for (const extension of extensions) {
    packageCounts.set(extension.identity!, (packageCounts.get(extension.identity!) ?? 0) + 1)
  }
  const duplicate = [...packageCounts].find(([, count]) => count > 1)
  if (duplicate) throw new Error(`[vitehub] Eve extension ${JSON.stringify(duplicate[0])} can only be mounted once per Agent Definition.`)
  const identifiers = new Set(references.keys())
  let helper = "__vitehubEveExtensionCapability"
  while (identifiers.has(helper)) helper += "_"
  const firstImport = extensions.reduce((first, extension) =>
    extension.declaration.start < first.declaration.start ? extension : first
  )
  const replacements: Array<{ end: number, start: number, value: string }> = []
  const runtimeImportIdentities = new Map<PositionedNode, string>()
  for (const statement of Array.isArray(program.body) ? program.body : []) {
    if (!isPositionedNode(statement) || statement.type !== "ImportDeclaration" || statement.importKind === "type") continue
    const specifiers = Array.isArray(statement.specifiers) ? statement.specifiers : []
    if (!specifiers.some(specifier => !isPositionedNode(specifier) || specifier.importKind !== "type")) continue
    const source = statement.source
    if (!isPositionedNode(source) || source.type !== "Literal" || typeof source.value !== "string") continue
    const identity = await resolveExtensionIdentity(source.value)
    if (identity) runtimeImportIdentities.set(statement, typeof identity === "string" ? identity : source.value)
  }
  for (const extension of extensions) {
    const separateRuntimeImport = [...runtimeImportIdentities]
      .find(([statement, identity]) => statement !== extension.declaration && identity === extension.identity)?.[0]
    if (separateRuntimeImport) {
      throw new Error(`[vitehub] Eve extension ${JSON.stringify(extension.source)} cannot be imported separately as a runtime value.`)
    }
    let hasSurvivingReference = false
    visitNodes(program, (node, parent) => {
      if (hasSurvivingReference || node.type !== "Identifier" || node.name !== extension.local) return
      if (parent?.type === "Property" && parent.computed !== true && parent.shorthand !== true && parent.key === node) return
      if (parent?.type === "MemberExpression" && parent.computed !== true && parent.property === node) return
      if (node.start >= extension.declaration.start && node.end <= extension.declaration.end) return
      if (extensions.some((candidate) => {
        const callee = candidate.call.callee
        return candidate.local === extension.local
          && isPositionedNode(callee)
          && node.start >= callee.start
          && node.end <= callee.end
      })) return
      if (shadowRanges.get(extension.local)?.some(range => node.start > range.start && node.end < range.end)) return
      hasSurvivingReference = true
    })
    if (hasSurvivingReference) {
      throw new Error(`[vitehub] Eve extension factory ${JSON.stringify(extension.local)} cannot be referenced outside its static Capability mount.`)
    }
    const args = Array.isArray(extension.call.arguments) ? extension.call.arguments : []
    const config = isPositionedNode(args[0]) ? code.slice(args[0].start, args[0].end) : "undefined"
    replacements.push({
      end: extension.call.end,
      start: extension.call.start,
      value: `await ${helper}(${JSON.stringify(extension.identity)}, ${JSON.stringify(eveExtensionIdentityNamespace(extension.identity!))}, () => import(${JSON.stringify(extension.source)}), () => import(${JSON.stringify(`${extension.source}/tools`)}), ${config})`,
    })
    const retainedSpecifiers = Array.isArray(extension.declaration.specifiers)
      ? extension.declaration.specifiers.filter((specifier) => {
          if (!isPositionedNode(specifier) || specifier.type === "ImportDefaultSpecifier") return false
          return specifier.importKind === "type" || extension.declaration.importKind === "type"
        })
      : []
    const valueCoImports = Array.isArray(extension.declaration.specifiers)
      ? extension.declaration.specifiers.filter(specifier => isPositionedNode(specifier) && specifier.type !== "ImportDefaultSpecifier" && specifier.importKind !== "type" && extension.declaration.importKind !== "type")
      : []
    if (valueCoImports.length) {
      throw new Error(`[vitehub] Eve extension ${JSON.stringify(extension.source)} cannot share its import with named runtime values.`)
    }
    replacements.push({
      end: extension.declaration.end,
      start: extension.declaration.start,
      value: [
        ...(extension === firstImport ? [`import { eveExtensionCapability as ${helper} } from ${JSON.stringify(`${agentImportBase}/eve`)}`] : []),
        ...(retainedSpecifiers.length
          ? [`import type { ${retainedSpecifiers.map(specifier => code.slice(specifier.start, specifier.end).replace(/^type\s+/, "")).join(", ")} } from ${JSON.stringify(extension.source)}`]
          : []),
      ].join("\n"),
    })
  }
  return applyCodeReplacements(code, replacements)
}

interface EveExtensionPackageJson {
  eve?: { extension?: { dist?: unknown } }
  name?: unknown
}

interface EveExtensionManifest {
  formatVersion?: unknown
  kind?: unknown
  requires?: unknown
}

const supportedEveExtensionContracts: Record<string, number> = {
  config: 1,
  dynamicTool: 8,
  extension: 1,
  tool: 5,
}

async function resolveEveExtensionPackage(
  config: Pick<ResolvedConfig, "createResolver">,
  specifier: string,
  importer: string,
  validate = true,
): Promise<false | string> {
  const entry = await config.createResolver()(specifier, importer)
  if (!entry) return false
  let directory = dirname(entry.split(/[?#]/, 1)[0]!)
  while (true) {
    const packagePath = join(directory, "package.json")
    if (existsSync(packagePath)) {
      const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as EveExtensionPackageJson
      if (typeof packageJson.name === "string" && packageJson.eve?.extension) {
        if (!validate) return packageJson.name
        const dist = packageJson.eve?.extension?.dist
        if (typeof dist !== "string") return false
        const manifestPath = resolve(directory, dist, "_manifest.json")
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as EveExtensionManifest
        if (manifest.kind !== "eve-extension" || manifest.formatVersion !== 1 || !manifest.requires || typeof manifest.requires !== "object") {
          throw new Error(`[vitehub] Eve extension ${JSON.stringify(specifier)} has an unsupported manifest.`)
        }
        for (const [contract, version] of Object.entries(manifest.requires)) {
          if (supportedEveExtensionContracts[contract] !== version) {
            throw new Error(`[vitehub] Eve extension ${JSON.stringify(specifier)} requires unsupported ${contract}@${String(version)}.`)
          }
        }
        return packageJson.name
      }
    }
    const parent = dirname(directory)
    if (parent === directory) return false
    directory = parent
  }
}

function generatedRuntimeHelpers(): string[] {
  return [
    "type ViteHubGeneratedCloudflare = { context?: unknown, env?: Record<string, unknown> }",
    "type ViteHubGeneratedEvent = H3Event & {",
    "  context: H3Event['context'] & {",
    "    _platform?: { cloudflare?: ViteHubGeneratedCloudflare }",
    "    cloudflare?: ViteHubGeneratedCloudflare",
    "  }",
    "  env?: Record<string, unknown>",
    "  node?: { req?: { runtime?: { cloudflare?: ViteHubGeneratedCloudflare } } }",
    "}",
    "",
    "function waitUntilFromValue(value: unknown): AgentWaitUntil | undefined {",
    "  const candidate = value as { waitUntil?: AgentWaitUntil } | undefined",
    "  return value && typeof value === 'object' && typeof candidate?.waitUntil === 'function' ? candidate.waitUntil.bind(value) : undefined",
    "}",
    "",
    "export function waitUntilFromEvent(event: H3Event) {",
    "  const runtimeEvent = event as ViteHubGeneratedEvent",
    "  return waitUntilFromValue(runtimeEvent)",
    "    || waitUntilFromValue(runtimeEvent.context)",
    "    || waitUntilFromValue(runtimeEvent.context?.cloudflare?.context)",
    "    || waitUntilFromValue(runtimeEvent.context?._platform?.cloudflare?.context)",
    "    || waitUntilFromValue(runtimeEvent.node?.req?.runtime?.cloudflare?.context)",
    "}",
    "",
    "function cloudflareFromEvent(event: H3Event): ViteHubGeneratedCloudflare | undefined {",
    "  const runtimeEvent = event as ViteHubGeneratedEvent",
    "  const env = runtimeEvent.env || runtimeEvent.context?.cloudflare?.env || runtimeEvent.context?._platform?.cloudflare?.env || runtimeEvent.node?.req?.runtime?.cloudflare?.env",
    "  const context = runtimeEvent.context?.cloudflare?.context || runtimeEvent.context?._platform?.cloudflare?.context || runtimeEvent.node?.req?.runtime?.cloudflare?.context",
    "  return env && typeof env === 'object' ? { env, ...(context ? { context } : {}) } : undefined",
    "}",
  ]
}

function generatedCloudflareChatStateHelper(): string[] {
  return [
    "",
    "function chatStateFromCloudflare(cloudflare: ViteHubGeneratedCloudflare | undefined) {",
    `  const namespace = (cloudflare?.env || getActiveCloudflareEnv())?.${defaultCloudflareAgentStateBinding} as ViteHubAgentStateDurableObjectNamespace | undefined`,
    "  const state = namespace ? createCloudflareAgentState({ namespace }) : undefined",
    "  if (state) Object.assign(state, { workflowCustody: true })",
    "  return state",
    "}",
  ]
}

function generatedLibsqlChatStateHelper(state: GeneratedLibsqlAgentStateOptions, typescript = false): string[] {
  const { authTokenEnvName, durableUrlRequired, ephemeralHosting, ...stateOptions } = state
  const configuredAuthTokenOption = authTokenEnvName
    ? [`  ...(typeof process === 'object' && process.env[${JSON.stringify(authTokenEnvName)}] ? { authToken: process.env[${JSON.stringify(authTokenEnvName)}] } : {}),`]
    : []
  return [
    "",
    `const viteHubChatStateOptions = ${JSON.stringify(stateOptions)}`,
    `let viteHubChatState${typescript ? ": ReturnType<typeof createLibsqlAgentState> | undefined" : ""}`,
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
    "viteHubChatStateResolver.workflowCustody = true",
  ]
}

function generatedWebhookQueueResumeHelper(routeCapabilities: { requestOption: string }, typescript = false, runtimeRouteOption = ""): string[] {
  return [
    `export function resumeWebhookQueues(waitUntil${typescript ? ": AgentWaitUntil | undefined" : ""}) {`,
    "  const runtimeUrl = typeof process === 'object' ? process.env.VITEHUB_AGENT_STATE_URL : undefined",
    "  if (!runtimeUrl && !viteHubChatStateOptions.url) return async () => undefined",
    `  const stops = Object.entries(webhookHandlers).flatMap(([name, handler]) => typeof handler.resume === 'function' ? [handler.resume({ agentIdentity: agentIdentities[name]${runtimeRouteOption}, ${routeCapabilities.requestOption}webhookState: viteHubChatStateResolver, waitUntil })] : [])`,
    "  return async () => await Promise.all(stops.map(stop => stop()))",
    "}",
    "",
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
    typescript?: boolean
    workspaceImportBase: string
    workspaceRuntimeImport?: string
  },
): Promise<GeneratedAgentDeploymentCatalog> {
  const channelHandlers = options.channelHandlers !== false
  const typescript = options.typescript === true
  const entries = await Promise.all(definitions.map(async (definition, index) => {
    const moduleName = `agent${index}`
    const sourceRootDir = resolveWorkspaceSourceRoot(definition.handler)
    const colocatedInstructions = await readColocatedAgentInstructions(definition.handler)
    const colocatedSkills = readColocatedAgentSkills(definition.handler)
    const colocatedHome = readColocatedAgentHome(definition.handler)
    const agentExpression = `agentWithColocatedHome(withWorkspaceSourceRoot(agentWithColocatedInstructions(resolveAgentModule(${moduleName}), ${JSON.stringify(colocatedInstructions)}), ${JSON.stringify(sourceRootDir)}, ${JSON.stringify(colocatedInstructions)}, ${JSON.stringify(colocatedSkills)}), ${JSON.stringify(colocatedHome)})`
    return {
      agentEntry: `${JSON.stringify(definition.name)}: ${agentExpression}`,
      import: `import * as ${moduleName} from ${JSON.stringify(moduleImportSpecifier(handlerPath, definition.handler))}`,
      workspaceEntry: definition.workspace
        ? `workspaceRegistryEntry(${JSON.stringify(definition.workspace)}, ${moduleName}, ${JSON.stringify(sourceRootDir)}, ${JSON.stringify(colocatedInstructions)}, ${JSON.stringify(colocatedSkills)}, ${JSON.stringify(colocatedHome)})`
        : undefined,
    }
  }))
  const hostedWorkspaceRuntime = generatedHostedWorkspaceRuntimeSetup(definitions, options.workspaceImportBase)
  const workspaceEntries = entries.flatMap(entry => entry.workspaceEntry ? [entry.workspaceEntry] : []).join(",\n  ")
  if (workspaceEntries && !options.workspaceRuntimeImport) {
    throw new TypeError("[vitehub] Agent deployment catalog requires a Workspace runtime import for Workspace Agents.")
  }
  const agentEntries = entries.map(entry => entry.agentEntry).join(",\n  ")
  const agentIdentityEntries = generatedAgentIdentityEntries(definitions)

  return {
    imports: [
      `import { ${typescript ? "type AgentHostIdentity, type AgentInput, type AgentRegistryModule, type AgentWaitUntil, type WorkspaceAgentDefinition, type WorkspaceAgentOptions, " : ""}agentWithColocatedInstructions, workspaceAgentOwnsWorkspaceDefinition, workspaceDefinitionFromOptions } from ${JSON.stringify(options.agentImportBase)}`,
      `import { agentWithColocatedHome } from ${JSON.stringify(subpath(options.agentImportBase, "runtime/workflow"))}`,
      ...(channelHandlers
        ? [`import { createChannelChatRouteHandler, createChannelWebhookRouteHandler, hasChannelChatRoute } from ${JSON.stringify(subpath(options.agentImportBase, "server/internal"))}`]
        : []),
      ...(options.workspaceRuntimeImport ? [`import { setWorkspaceRuntimeRegistry } from ${JSON.stringify(options.workspaceRuntimeImport)}`] : []),
      ...hostedWorkspaceRuntime.imports,
      ...entries.map(entry => entry.import),
    ],
    setup: [
      ...(typescript
        ? [
            "type ViteHubEncodedColocatedSkills = Record<string, { content: string, encoding: 'base64', [key: string]: unknown }>",
            "",
          ]
        : []),
      `function resolveAgentModule(module${typescript ? ": AgentRegistryModule" : ""})${typescript ? ": AgentInput" : ""} {`,
      "  const agent = module && typeof module === 'object' && 'default' in module ? module.default : module",
      ...(typescript
        ? [
            "  if (!agent) throw new TypeError('[vitehub] Generated Agent module does not export an Agent definition.')",
          ]
        : []),
      `  return agent${typescript ? " as AgentInput" : ""}`,
      "}",
      "",
      ...generatedWorkspaceSourceRootHelper("withWorkspaceSourceRoot", "workspaceDefinitionFromOptions", typescript),
      "",
      `function workspaceRegistryEntry(name${typescript ? ": string" : ""}, module${typescript ? ": AgentRegistryModule" : ""}, sourceRootDir${typescript ? ": string" : ""}, colocatedInstructions${typescript ? ": string | undefined" : ""}, colocatedSkills${typescript ? ": ViteHubEncodedColocatedSkills | undefined" : ""}, colocatedHome${typescript ? ": Parameters<typeof agentWithColocatedHome>[1]" : ""}) {`,
      "  const agent = agentWithColocatedHome(withWorkspaceSourceRoot(agentWithColocatedInstructions(resolveAgentModule(module), colocatedInstructions), sourceRootDir, colocatedInstructions, colocatedSkills), colocatedHome)",
      "  if (!workspaceAgentOwnsWorkspaceDefinition(agent)) return",
      "  return [name, async () => ({ ...module, default: agent })]",
      "}",
      "",
      ...hostedWorkspaceRuntime.setup,
      ...(options.workspaceRuntimeImport
        ? [`setWorkspaceRuntimeRegistry(Object.fromEntries([${workspaceEntries ? `\n  ${workspaceEntries}\n` : ""}].filter(Boolean)))`, ""]
        : []),
      `const agents = {${agentEntries ? `\n  ${agentEntries}\n` : ""}}`,
      `const agentIdentities${typescript ? ": Record<string, AgentHostIdentity>" : ""} = {${agentIdentityEntries ? `\n  ${agentIdentityEntries}\n` : ""}}`,
      ...(channelHandlers
        ? [
            "const chatHandlers = Object.fromEntries(Object.entries(agents).filter(([, agent]) => hasChannelChatRoute(agent)).map(([name, agent]) => [name, createChannelChatRouteHandler(agent)]))",
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
  options: { cloudflareState?: boolean, libsqlState?: GeneratedLibsqlAgentStateOptions, processDiscordGateway?: boolean, runtime?: "vite", webhookRoute?: false | string } & AgentGeneratedImportOptions = {},
): Promise<string> {
  const agentImportBase = options.agentImportBase ?? agentPackageName
  const workspaceImportBase = options.workspaceImportBase ?? workspacePackageName
  const routeCapabilities = generatedAgentRouteCapabilities(options)
  const workflowRuntime = generatedAgentWorkflowRuntime(options, agentImportBase)
  const workspaceDependencyRuntime = generatedAgentWorkspaceDependencyRuntime(options, workspaceImportBase)
  const runtimeRouteOption = options.runtime === "vite" ? ", runtime: 'vite'" : ""
  const deploymentCatalog = await generateAgentDeploymentCatalog(definitions, handlerPath, {
    agentImportBase,
    typescript: true,
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
  const gatewayStateOption = options.libsqlState ? "state: viteHubChatStateResolver, " : ""

  return [
    ...deploymentCatalog.imports,
    ...(options.cloudflareState
      ? [
          `import { createCloudflareAgentState, getActiveCloudflareEnv } from ${JSON.stringify(subpath(agentImportBase, "cloudflare"))}`,
          `import type { ViteHubAgentStateDurableObjectNamespace } from ${JSON.stringify(subpath(agentImportBase, "cloudflare"))}`,
        ]
      : []),
    ...(options.libsqlState ? [`import { createLibsqlAgentState } from ${JSON.stringify(subpath(agentImportBase, "state/sqlite"))}`] : []),
    ...(options.processDiscordGateway ? [`import { createDiscordGatewayRouteHandler } from ${JSON.stringify(subpath(agentImportBase, "server/internal"))}`] : []),
    ...workflowRuntime.imports,
    ...workspaceDependencyRuntime.imports,
    ...routeCapabilities.imports,
    "import { createError, defineEventHandler, getRequestHeaders, getRequestURL, getRouterParam, readRawBody, type H3Event } from 'h3'",
    "",
    ...workflowRuntime.setup,
    ...workspaceDependencyRuntime.setup,
    ...deploymentCatalog.setup,
    "async function toRequest(event: H3Event) {",
    "  const body = await readRawBody(event)",
    "  const request = event.node!.req",
    "  const response = event.node!.res!",
    "  const controller = new AbortController()",
    "  const abort = () => controller.abort(new DOMException('Client disconnected.', 'AbortError'))",
    "  if (request.aborted) abort()",
    "  else request.once('aborted', abort)",
    "  response.once('close', () => { if (!response.writableEnded) abort() })",
    "  return new Request(getRequestURL(event), {",
    "    body: body || undefined,",
    "    headers: getRequestHeaders(event),",
    "    method: event.method || 'POST',",
    "    signal: controller.signal,",
    "  })",
    "}",
    "",
    ...generatedRuntimeHelpers(),
    ...(options.cloudflareState ? generatedCloudflareChatStateHelper() : []),
    ...(options.libsqlState ? generatedLibsqlChatStateHelper(options.libsqlState, true) : []),
    "",
    ...routeCapabilities.setup,
    ...(options.libsqlState ? generatedWebhookQueueResumeHelper(routeCapabilities, true, runtimeRouteOption) : []),
    ...(options.processDiscordGateway
      ? [
          "function hasDiscordGatewayChannel(agent: unknown): boolean {",
          "  if (!agent || typeof agent !== 'object' || !('channels' in agent) || !agent.channels || typeof agent.channels !== 'object') return false",
          "  return Object.values(agent.channels).some(channel => {",
          "    const definition = channel as { adapter?: unknown, kind?: unknown, messages?: unknown } | undefined",
          "    return definition?.kind === 'discord' && Boolean(definition.adapter) && definition.messages !== false",
          "  })",
          "}",
          "",
          "const discordGatewayHandlers = Object.fromEntries(Object.entries(agents).filter(([, agent]) => hasDiscordGatewayChannel(agent)).map(([name, agent]) => [name, createDiscordGatewayRouteHandler(agent)]))",
          `const defaultDiscordGatewayDurationMs = ${JSON.stringify(9 * 60 * 1000)}`,
          "const discordGatewayDurationMs = Number(process.env.VITEHUB_DISCORD_GATEWAY_DURATION_MS || '') || defaultDiscordGatewayDurationMs",
          `const discordGatewayRetryMs = ${JSON.stringify(5 * 1000)}`,
          "",
          "function waitForDiscordGatewayRetry(signal: AbortSignal): Promise<void> {",
          "  if (signal.aborted) return Promise.resolve()",
          "  return new Promise(resolve => {",
          "    const done = () => {",
          "      clearTimeout(timer)",
          "      signal.removeEventListener('abort', done)",
          "      resolve()",
          "    }",
          "    const timer = setTimeout(done, discordGatewayRetryMs)",
          "    signal.addEventListener('abort', done, { once: true })",
          "  })",
          "}",
          "",
          "export function startDiscordGateways(): () => Promise<void> {",
          "  const controller = new AbortController()",
          "  const running = Promise.all(Object.entries(discordGatewayHandlers).map(async ([name, handler]) => {",
          "    while (!controller.signal.aborted) {",
          "      try {",
          `        const response = await handler(new Request("http://vitehub.local/api/_vitehub/agents/" + encodeURIComponent(name) + "/discord/gateway"), { agentIdentity: agentIdentities[name]${runtimeRouteOption}, ${routeCapabilities.requestOption}${gatewayStateOption}abortSignal: controller.signal, durationMs: discordGatewayDurationMs })`,
          "        if (!response.ok) throw new Error(`Discord Gateway listener failed with ${response.status}.`)",
          "      }",
          "      catch (error) {",
          "        if (controller.signal.aborted) break",
          "        console.error('[vitehub:agent] Discord Gateway listener failed and will retry.', error)",
          "        await waitForDiscordGatewayRetry(controller.signal)",
          "      }",
          "    }",
          "  }))",
          "  return async () => {",
          "    controller.abort()",
          "    await running",
          "  }",
          "}",
          "",
        ]
      : []),
    `const webhookRoutePattern = new RegExp(${JSON.stringify(routeRegexSource(options.webhookRoute))})`,
    "",
    "export default defineEventHandler(async (event) => {",
    "  const pathname = getRequestURL(event).pathname",
    "  const isWebhookRoute = webhookRoutePattern.test(pathname)",
    "  const agent = getRouterParam(event, 'agent') || (agentNames.length === 1 ? agentNames[0] : undefined)",
    `  const webhook = ${webhookSelector}`,
    "  if (!agent) {",
    "    throw createError({ statusCode: 404, statusMessage: 'Unknown ViteHub agent.' })",
    "  }",
    "  const cloudflare = cloudflareFromEvent(event)",
    "  if (isWebhookRoute) {",
    "    const handler = webhookHandlers[agent]",
    "    if (!handler) throw createError({ statusCode: 404, statusMessage: 'Unknown ViteHub agent.' })",
    `    return await handler(await toRequest(event), webhook, { agentIdentity: agentIdentities[agent], ${routeCapabilities.requestOption}cloudflare${runtimeRouteOption}, ${webhookStateOption}waitUntil: waitUntilFromEvent(event) })`,
    "  }",
    "  const handler = chatHandlers[agent]",
    "  if (!handler) throw createError({ statusCode: 404, statusMessage: 'Unknown ViteHub agent.' })",
    `  return await handler(await toRequest(event), { agentIdentity: agentIdentities[agent], ${routeCapabilities.requestOption}cloudflare${runtimeRouteOption}, event, waitUntil: waitUntilFromEvent(event) })`,
    "})",
    "",
  ].join("\n")
}

async function generateAgentNetlifyFunctionRouteHandler(
  definitions: DiscoveredAgentDefinition[],
  handlerPath: string,
  options: { discordGatewayRoute?: false | string, libsqlState?: GeneratedLibsqlAgentStateOptions, runtime?: "vite", webhookRoute?: false | string } & AgentGeneratedImportOptions = {},
): Promise<string> {
  const agentImportBase = options.agentImportBase ?? agentPackageName
  const workspaceImportBase = options.workspaceImportBase ?? workspacePackageName
  const routeCapabilities = generatedAgentRouteCapabilities(options)
  const workflowRuntime = generatedAgentWorkflowRuntime(options, agentImportBase)
  const workspaceDependencyRuntime = generatedAgentWorkspaceDependencyRuntime(options, workspaceImportBase)
  const runtimeRouteOption = options.runtime === "vite" ? ", runtime: 'vite'" : ""
  const deploymentCatalog = await generateAgentDeploymentCatalog(definitions, handlerPath, {
    agentImportBase,
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
    ...(options.libsqlState ? generatedWebhookQueueResumeHelper(routeCapabilities, false, runtimeRouteOption) : []),
    "const discordGatewayHandlers = Object.fromEntries(Object.entries(agents).map(([name, agent]) => [name, createDiscordGatewayRouteHandler(agent)]))",
    `const webhookRoute = ${JSON.stringify(generatedWebhookRoute(options.webhookRoute))}`,
    `const defaultDiscordGatewayDurationMs = ${JSON.stringify(9 * 60 * 1000)}`,
    `const chatRoutePattern = new RegExp(${JSON.stringify(routeRegexSource(defaultAgentChatRoute))})`,
    `const webhookRoutePattern = new RegExp(${JSON.stringify(routeRegexSource(options.webhookRoute))})`,
    `const discordGatewayRoutePattern = new RegExp(${JSON.stringify(routeRegexSource(options.discordGatewayRoute))})`,
    ...(options.libsqlState ? ["let stopWebhookQueues"] : []),
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
    ...(options.libsqlState ? ["  stopWebhookQueues ||= resumeWebhookQueues(waitUntil)"] : []),
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
  options: { cloudflareState?: boolean, libsqlState?: GeneratedLibsqlAgentStateOptions, processDiscordGateway?: boolean, runtime?: "vite", webhookRoute?: false | string } & AgentGeneratedImportOptions = {},
  serverDirs = [join(root, "server")],
): Promise<void> {
  const handlerPath = join(root, generatedAgentWebhookRouteHandler)
  const definitions = discoverAgentDefinitions({
    mode: "server-agents",
    scanDirs: serverDirs,
  })
  await mkdir(dirname(handlerPath), { recursive: true })
  await writeFile(handlerPath, await generateAgentWebhookRouteHandler(definitions, handlerPath, options), "utf8")
  const gatewayPluginPath = join(root, generatedAgentDiscordGatewayPlugin)
  if (options.processDiscordGateway) {
    await writeFile(gatewayPluginPath, [
      `import { startDiscordGateways } from ${JSON.stringify(`./${generatedAgentWebhookRouteHandler.split("/").at(-1)!.replace(/\.ts$/, "")}`)}`,
      "",
      "export default function viteHubDiscordGatewayPlugin(nitroApp) {",
      "  const stop = startDiscordGateways()",
      "  let stopping",
      "  const nodeProcess = typeof process === 'object' && process?.release?.name === 'node' ? process : undefined",
      "  const shutdownSignals = ['SIGINT', 'SIGTERM'].filter(signal => nodeProcess?.listenerCount(signal))",
      "  function stopDiscordGateways() {",
      "    for (const signal of shutdownSignals) nodeProcess?.off(signal, stopDiscordGateways)",
      "    return stopping ||= stop()",
      "  }",
      "  for (const signal of shutdownSignals) nodeProcess?.prependOnceListener(signal, stopDiscordGateways)",
      "  nitroApp.hooks.hook('close', stopDiscordGateways)",
      "}",
      "",
    ].join("\n"), "utf8")
  }
  else {
    await rm(gatewayPluginPath, { force: true })
  }
  const queuePluginPath = join(root, generatedAgentWebhookQueuePlugin)
  if (options.libsqlState) {
    await writeFile(queuePluginPath, [
      `import { resumeWebhookQueues, waitUntilFromEvent } from ${JSON.stringify(`./${generatedAgentWebhookRouteHandler.split("/").at(-1)!.replace(/\.ts$/, "")}`)}`,
      "",
      "export default function viteHubWebhookQueuePlugin(nitroApp) {",
      "  let stop",
      "  let stopping",
      "  let waitUntil",
      "  let shutdownSignals = []",
      "  const nodeProcess = typeof process === 'object' && process?.release?.name === 'node' ? process : undefined",
      "  function shutdownWebhookQueues() {",
      "    for (const signal of shutdownSignals) nodeProcess?.off(signal, shutdownWebhookQueues)",
      "    shutdownSignals = []",
      "    stopping ||= stop?.()",
      "    if (stopping) waitUntil?.(stopping)",
      "    return stopping",
      "  }",
      "  nitroApp.hooks.hook('request', event => {",
      "    if (stop) return",
      "    waitUntil ||= waitUntilFromEvent(event)",
      "    stop = resumeWebhookQueues(waitUntil)",
      "    shutdownSignals = ['SIGINT', 'SIGTERM'].filter(signal => nodeProcess?.listenerCount(signal))",
      "    for (const signal of shutdownSignals) nodeProcess?.prependOnceListener(signal, shutdownWebhookQueues)",
      "  })",
      "  nitroApp.hooks.hook('close', shutdownWebhookQueues)",
      "}",
      "",
    ].join("\n"), "utf8")
  }
  else {
    await rm(queuePluginPath, { force: true })
  }
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
    typescript: true,
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
    "import { createError, defineEventHandler, getRequestHeader, getRequestHeaders, getRequestURL, getRouterParam, type H3Event } from 'h3'",
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
  serverDirs = [join(root, "server")],
): Promise<void> {
  const handlerPath = join(root, generatedAgentDiscordGatewayRouteHandler)
  const definitions = discoverAgentDefinitions({
    mode: "server-agents",
    scanDirs: serverDirs,
  })
  await mkdir(dirname(handlerPath), { recursive: true })
  await writeFile(handlerPath, await generateAgentDiscordGatewayRouteHandler(definitions, handlerPath, options), "utf8")
}

async function generateAgentDenoServer(
  definitions: DiscoveredAgentDefinition[],
  handlerPath: string,
  options: { libsqlState?: GeneratedLibsqlAgentStateOptions, webhookRoute?: false | string } & AgentGeneratedImportOptions = {},
): Promise<string> {
  const agentImportBase = options.agentImportBase ?? agentPackageName
  const workspaceImportBase = options.workspaceImportBase ?? workspacePackageName
  const routeCapabilities = generatedAgentRouteCapabilities(options)
  const workflowRuntime = generatedAgentWorkflowRuntime(options, agentImportBase)
  const workspaceDependencyRuntime = generatedAgentWorkspaceDependencyRuntime(options, workspaceImportBase)
  const deploymentCatalog = await generateAgentDeploymentCatalog(definitions, handlerPath, {
    agentImportBase,
    typescript: true,
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
    `await import(${JSON.stringify(options.denoCronImport ?? "../schedule/deno-cron.mjs")}).catch((error) => {`,
    "  if (error instanceof TypeError && String(error.message).includes('deno-cron.mjs')) return",
    "  throw error",
    "})",
    "",
    ...deploymentCatalog.setup,
    ...(options.libsqlState ? generatedLibsqlChatStateHelper(options.libsqlState, true) : []),
    ...routeCapabilities.setup,
    ...(options.libsqlState ? generatedWebhookQueueResumeHelper(routeCapabilities, true) : []),
    "function jsonError(status, message) {",
    "  return Response.json({ error: true, status, statusText: message, message }, { status })",
    "}",
    "",
    "function decodeRouteParam(value) {",
    "  try { return decodeURIComponent(value || '') }",
    "  catch { return value || '' }",
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
    `const chatRoutePattern = new RegExp(${JSON.stringify(routeRegexSource(defaultAgentChatRoute, ["agent"]))})`,
    `const webhookRoutePattern = new RegExp(${JSON.stringify(routeRegexSource(options.webhookRoute, ["agent", "webhook"]))})`,
    "",
    "async function handleRequest(request) {",
    "  const pathname = new URL(request.url).pathname",
    "  const chatMatch = chatRoutePattern.exec(pathname)",
    "  const webhookMatch = webhookRoutePattern.exec(pathname)",
    "  const isWebhookRoute = Boolean(webhookMatch)",
    "  const groups = (webhookMatch || chatMatch)?.groups || {}",
    "  const agent = groups.agent ? decodeRouteParam(groups.agent) : (agentNames.length === 1 ? agentNames[0] : undefined)",
    "  const webhook = decodeRouteParam(groups.webhook)",
    "  const handler = agent ? (isWebhookRoute ? webhookHandlers[agent] : chatHandlers[agent]) : undefined",
    "  if (!handler || (!chatMatch && !webhookMatch)) return jsonError(404, 'Unknown ViteHub agent route.')",
    `  return isWebhookRoute ? await handler(request, webhook, { agentIdentity: agentIdentities[agent]${routeCapabilities.requestProperty}${options.libsqlState ? ", state: viteHubChatStateResolver, webhookState: viteHubChatStateResolver" : ""} }) : await handler(request, { agentIdentity: agentIdentities[agent]${routeCapabilities.requestProperty}${options.libsqlState ? ", state: viteHubChatStateResolver" : ""} })`,
    "}",
    "",
    "const serveOptions = resolveDenoServeOptions(Deno.args)",
    ...(options.libsqlState ? ["const stopWebhookQueues = resumeWebhookQueues()"] : []),
    "const server = serveOptions ? Deno.serve(serveOptions, handleRequest) : Deno.serve(handleRequest)",
    "try {",
    "  if (server?.finished) await server.finished",
    "}",
    "finally {",
    ...(options.libsqlState ? ["  await stopWebhookQueues()"] : []),
    "}",
    "",
  ].join("\n")
}

async function writeAgentDenoServer(
  root: string,
  options: { libsqlState?: GeneratedLibsqlAgentStateOptions, webhookRoute?: false | string } & AgentGeneratedImportOptions = {},
  serverDirs = [join(root, "server")],
): Promise<void> {
  const handlerPath = join(root, generatedAgentDenoServer)
  const definitions = discoverAgentDefinitions({
    mode: "server-agents",
    scanDirs: serverDirs,
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
  options: { discordGatewayRoute?: false | string, libsqlState?: GeneratedLibsqlAgentStateOptions, runtime?: "vite", webhookRoute?: false | string } & AgentGeneratedImportOptions = {},
  serverDirs = [join(root, "server")],
): Promise<string> {
  const handlerPath = join(root, generatedAgentNetlifyFunction)
  const definitions = discoverAgentDefinitions({
    mode: "server-agents",
    scanDirs: serverDirs,
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

function createNetlifyAgentFunctionConfig(options: { discordGatewayRoute?: false | string, webhookRoute?: false | string }): object {
  const paths = [
    normalizeNitroRoute(defaultAgentChatRoute),
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
  serverDirs?: string[],
): Promise<void> {
  const handlerPath = await writeAgentNetlifyFunctionRouteHandler(resolveViteHubGeneratedRoot(config), {
    ...generatedOptions,
    discordGatewayRoute: options.routes.discordGateway,
    libsqlState: generatedOptions.libsqlState ?? resolveLibsqlAgentState(options, config),
    webhookRoute: options.routes.webhooks,
  }, serverDirs ?? [join(config.root, "server")])
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
  const eveExtensionOwners = new Map<string, string>()
  let installsCloudflareState = false
  let resolved: ResolvedConfig | undefined
  let serverDirs: string[] | undefined

  function clearEveExtensionOwnership(owner: string): void {
    for (const [specifier, currentOwner] of eveExtensionOwners) {
      if (currentOwner === owner) eveExtensionOwners.delete(specifier)
    }
  }

  function workflowState(config: ResolvedConfig) {
    const normalized = normalizeAgentOptions(agent)
    installsCloudflareState ||= shouldInstallCloudflareAgentState(normalized, config)
    return {
      cloudflare: installsCloudflareState,
      libsql: installsCloudflareState ? undefined : resolveLibsqlAgentState(normalized, config),
    }
  }

  async function writeGeneratedAgentOutputs(config: ResolvedConfig) {
    const normalized = normalizeAgentOptions(agent)
    const processDiscordGateway = Boolean(getInternalAgentOptions(agent)?.processDiscordGateway)
    const schedule = hasScheduleVitePlugin(config)
    const hasHostedAgents = hasHostedAgentDefinitions(config.root, serverDirs)
    const generatedRoot = resolveViteHubGeneratedRoot(config)
    const definitionServerDirs = serverDirs ?? [join(config.root, "server")]
    if (normalized && hasHostedAgents) {
      if (normalized.runtime === "deno") {
        await writeAgentDenoServer(generatedRoot, {
          agentImportBase: getAgentImportBase(agent, frameworkOptions),
          denoCronImport: moduleImportSpecifier(
            join(generatedRoot, generatedAgentDenoServer),
            join(config.root, ".vitehub", "schedule", "deno-cron.mjs"),
          ),
          libsqlState: resolveLibsqlAgentState(normalized, config),
          runtimeCapabilities: standaloneRuntimeCapabilities,
          schedule,
          scheduleRuntimeImport: getScheduleRuntimeImport(agent, frameworkOptions),
          workflowImportBase: getWorkflowImportBase(agent, frameworkOptions),
          workspaceDependencyRuntimeImports: getWorkspaceDependencyRuntimeImports(agent, frameworkOptions),
          workspaceImportBase: getWorkspaceImportBase(agent, frameworkOptions),
          webhookRoute: normalized.routes.webhooks,
        }, definitionServerDirs)
      }
      else {
        await writeAgentWebhookRouteHandler(generatedRoot, {
          agentImportBase: getAgentImportBase(agent, frameworkOptions),
          cloudflareState: shouldInstallCloudflareAgentState(normalized, config),
          libsqlState: resolveLibsqlAgentState(normalized, config),
          processDiscordGateway,
          ...(config.command === "serve" ? { runtime: "vite" as const } : {}),
          runtimeCapabilities,
          schedule,
          scheduleRuntimeImport: getScheduleRuntimeImport(agent, frameworkOptions),
          workflowImportBase: getWorkflowImportBase(agent, frameworkOptions),
          workspaceDependencyRuntimeImports: getWorkspaceDependencyRuntimeImports(agent, frameworkOptions),
          workspaceImportBase: getWorkspaceImportBase(agent, frameworkOptions),
          webhookRoute: normalized.routes.webhooks,
        }, definitionServerDirs)
        if (normalized.routes.discordGateway && !processDiscordGateway) {
          await writeAgentDiscordGatewayRouteHandler(generatedRoot, {
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
          }, definitionServerDirs)
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
          }, definitionServerDirs)
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
      const clearUnlinkedEveExtensionOwnership = (file: string) => clearEveExtensionOwnership(file.replace(/\\/g, "/"))
      server.watcher?.on("add", clearUnlinkedEveExtensionOwnership)
      server.watcher?.on("unlink", clearUnlinkedEveExtensionOwnership)
      if (agent !== false) {
        await registerAgentInvocationStreamEndpoint(server, {
          runtimeCapabilities,
          schedule: hasScheduleVitePlugin(resolved ?? server.config),
          scheduleRuntimeImport: getScheduleRuntimeImport(agent, frameworkOptions),
        })
      }
    },
    async handleHotUpdate(context) {
      const file = context.file.replace(/\\/g, "/")
      clearEveExtensionOwnership(file)
      const agentRoots = (serverDirs ?? [join(resolved?.root ?? context.server.config.root, "server")])
        .map(directory => `${resolve(directory).replace(/\\/g, "/")}/agents/`)
      const relativeAgentPath = agentRoots
        .filter(directory => file.startsWith(directory))
        .map(directory => file.slice(directory.length))
        .find(path => /\.(?:c|m)?[jt]s$/i.test(path) || /\/(?:home|skills)\/.*$/i.test(path))
      const instructionUpdate = Boolean(
        resolved?.root
        && /\.md$/i.test(file)
        && await isColocatedAgentInstructionDependency(resolved.root, file, serverDirs),
      )
      if (!instructionUpdate && !/\.agent\.(?:c|m)?[jt]s$/i.test(file) && !relativeAgentPath) return
      const colocatedResourceUpdate = instructionUpdate || Boolean(relativeAgentPath && /\/(?:home|skills)\/.*$/i.test(relativeAgentPath))
      if (resolved && colocatedResourceUpdate) {
        await writeGeneratedAgentOutputs(resolved)
      }
      const moduleIds = [resolvedScheduleRegistryId, resolvedScheduleTargetsId]
      if (resolved?.root) {
        moduleIds.push(join(resolved.root, generatedScheduleRuntimeRegistrySuffix).replace(/\\/g, "/"))
        if (colocatedResourceUpdate) {
          const root = resolveViteHubGeneratedRoot(resolved)
          moduleIds.push(...[
            generatedAgentDenoServer,
            generatedAgentDiscordGatewayRouteHandler,
            generatedAgentDiscordGatewayPlugin,
            generatedAgentNetlifyFunction,
            generatedAgentWebhookRouteHandler,
            generatedAgentWebhookQueuePlugin,
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
      const normalizedId = id.split(/[?#]/, 1)[0]!.replace(/\\/g, "/")
      const typescriptModule = /\.(?:c|m)?[jt]s$/i.test(normalizedId)
      const definitionServerDirs = serverDirs ?? [join(resolved.root, "server")]
      const serverProjectModule = definitionServerDirs.some(directory =>
        normalizedId.startsWith(`${resolve(directory).replace(/\\/g, "/")}/`),
      )
      const serverAgentDefinition = definitionServerDirs.some((directory) => {
        const agentRoot = `${resolve(directory, "agents").replace(/\\/g, "/")}/`
        return normalizedId.startsWith(agentRoot) && typescriptModule
      })
      const projectModule = typescriptModule
        && (normalizedId.startsWith(`${resolve(resolved.root).replace(/\\/g, "/")}/`) || serverProjectModule)
      const agentDefinition = /\.agent\.(?:c|m)?[jt]s$/i.test(normalizedId)
        || serverAgentDefinition
      let transformed = code
      if (agentDefinition) {
        transformed = transformRepositoryHostContextMaterialization(code, value => this.parse(value)) ?? code
      }
      if (projectModule) {
        clearEveExtensionOwnership(normalizedId)
        transformed = await transformEveExtensionCapabilities(
          transformed,
          value => this.parse(value),
          async (specifier) => {
            const identity = await resolveEveExtensionPackage(resolved!, specifier, normalizedId)
            if (!identity) return false
            const owner = eveExtensionOwners.get(identity)
            if (owner && owner !== normalizedId) {
              throw new Error(`[vitehub] Eve extension ${JSON.stringify(specifier)} can only be mounted once per Vite app.`)
            }
            eveExtensionOwners.set(identity, normalizedId)
            return identity
          },
          getAgentImportBase(agent, frameworkOptions),
          specifier => resolveEveExtensionPackage(resolved!, specifier, normalizedId, false),
        ) ?? transformed
        if (transformed !== code) return transformed
      }
      if (isGeneratedAgentWorkflowRegistryId(normalizedId)) {
        return transformGeneratedAgentWorkflowRegistry(
          code,
          runtimeCapabilities,
          getAgentImportBase(agent, frameworkOptions),
          workflowState(resolved!),
        )
      }
      if (!isScheduleRegistryId(id) && id !== resolvedScheduleTargetsId) return
      const definitions = discoverScheduledAgentDefinitions(resolved.root, serverDirs)
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
      agent: {
        transformWorkflowRegistry: (code, id) => isGeneratedAgentWorkflowRegistryId(id)
          ? transformGeneratedAgentWorkflowRegistry(
              code,
              runtimeCapabilities,
              getAgentImportBase(agent, frameworkOptions),
              workflowState(resolved!),
            )
          : code,
      },
      cli: async () => {
        const { createAgentCliContributor } = await import(/* @vite-ignore */ "./cli.js")
        if (agent === false || agent?.cli === false) return createAgentCliContributor(false)
        return createAgentCliContributor({
          eval: agent?.eval,
          rootDir: resolved?.root ?? process.cwd(),
          serverDirs,
        })
      },
    },
    config(config, environment) {
      agent = config.agent ?? agent
      const resolved = normalizeAgentOptions(agent)
      serverDirs = (config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS] ?? serverDirs
      const root = resolve(config.root || process.cwd())
      if (hasNitroConfigContext(config)) {
        runtimeCapabilities = configuredGeneratedAgentRuntimeCapabilities(
          (config.plugins || []).filter(Boolean) as Plugin[],
          getInternalAgentOptions(agent)?.runtimeCapabilityImports ?? frameworkOptions?.runtimeCapabilityImports,
        )
      }
      const generatedRoot = resolveViteHubGeneratedRoot(config)
      const nitroContext = hasNitroConfigContext(config)
      const hasHostedAgents = Boolean(resolved && hasHostedAgentDefinitions(root, serverDirs))
      const denoOutput = resolved && resolved.runtime === "deno"
      const installCloudflareState = hasHostedAgents && !denoOutput && shouldInstallCloudflareAgentState(resolved, config, environment?.command)
      installsCloudflareState ||= installCloudflareState
      const stateProvider = resolved && resolved.providers.state.provider
      const installWebhookQueue = Boolean(
        resolved
        && hasHostedAgents
        && !denoOutput
        && !installCloudflareState
        && (stateProvider === "auto" || stateProvider === "sqlite" || stateProvider === "libsql"),
      )
      const installProcessDiscordGateway = Boolean(
        resolved
        && hasHostedAgents
        && !denoOutput
        && getInternalAgentOptions(agent)?.processDiscordGateway,
      )
      const nitroHandlers = [
        ...(resolved && hasHostedAgents && !denoOutput
          ? [{
              handler: join(generatedRoot, generatedAgentWebhookRouteHandler),
              route: normalizeNitroRoute(defaultAgentChatRoute),
            }]
          : []),
        ...(resolved && hasHostedAgents && !denoOutput
          ? [{
              handler: join(generatedRoot, generatedAgentWebhookRouteHandler),
              route: normalizeNitroRoute(resolved.routes.webhooks),
            }]
          : []),
        ...(resolved && hasHostedAgents && !denoOutput && resolved.routes.discordGateway && !installProcessDiscordGateway
          ? [{
              handler: join(generatedRoot, generatedAgentDiscordGatewayRouteHandler),
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
      const mergedNitro = (nitroContext ? mergeAgentNitroExternals : cloneNitroConfig)(mergeNitroPlugins(
        mergeNitroHandlers(nitro, nitroHandlers),
        [
          ...(installWebhookQueue ? [join(generatedRoot, generatedAgentWebhookQueuePlugin)] : []),
          ...(installProcessDiscordGateway ? [join(generatedRoot, generatedAgentDiscordGatewayPlugin)] : []),
        ],
      ))
      return {
        ...(typeof agent !== "undefined" ? { agent } : {}),
        ...(nitroHandlers.length
          ? {
              build: mergeBuildExternal(config as BuildWithRolldownOptions, optionalMessageAdapterRuntimeExternals),
            }
          : {}),
        ...(nitroContext || nitroHandlers.length || installCloudflareState || installProcessDiscordGateway
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
      installsCloudflareState ||= shouldInstallCloudflareAgentState(normalizeAgentOptions(agent), config)
      serverDirs = (config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS] ?? serverDirs
      const generatedRoot = resolveViteHubGeneratedRoot(config)
      runtimeCapabilities = await resolveGeneratedAgentRuntimeCapabilities(
        config,
        getInternalAgentOptions(agent)?.runtimeCapabilityImports ?? frameworkOptions?.runtimeCapabilityImports,
      )
      standaloneRuntimeCapabilities = await writeStandaloneAgentRuntimeCapabilities(config, runtimeCapabilities)
      await writeGeneratedAgentOutputs(config)
      if (agent === false || !discoverAgentEvalFiles([config.root, ...(serverDirs ?? [])]).length) {
        await removeAgentEvaliteConfig(config.root, generatedRoot)
        return
      }

      const evalOptions = resolveAgentEvalOptions(agent?.eval)
      await writeAgentEvaliteConfig(config.root, evalOptions, generatedRoot)
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
        if (normalized && hasHostedAgentDefinitions(resolved.root, serverDirs) && isNetlifyHosting(resolved)) {
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
          }, serverDirs)
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
