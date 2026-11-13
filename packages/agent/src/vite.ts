import { validateAgentStaticRoute } from "./internal/routes.ts"
import { channelSimulationEnv } from "./internal/channel-simulation.ts"
import { randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import { existsSync, readFileSync, statSync } from "node:fs"
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { contributeProviderDeploymentOutput, createDefaultNetlifyOutputRoot, createProviderDeploymentOutputGenerationState, finalizeProviderDeploymentOutputs, getProviderOutputCatalog, useProviderOutputCatalog, writeProviderDeploymentOutputs } from "@vite-hub/internal/build/deployment-output"
import { resolveDurabilityModule } from "@vite-hub/internal/durability"
import { sqliteUrlInput } from "@vite-hub/runtime/durability"
import { encodeProviderOutputAliases, resolveViteHubBundleDefines } from "@vite-hub/internal/build/bundle-options"
import { scanModule } from "@vite-hub/internal/build/scan-module"
import { providerOutputAliasSources, rebasePublishedProviderSourceLinks, removeProviderOutputArtifactDir, retainProviderOutputAliases, retainProviderOutputSources, rewriteRetainedProviderSourcePaths } from "@vite-hub/internal/build/provider-output-sources"
import { copyNodeRuntimePackages, copyVercelFunctionRuntimePackages } from "@vite-hub/internal/build/vercel-runtime-packages"
import { deploymentPresetFromNitro } from "@vite-hub/internal/deployment"
import { registerViteHubNitroDevEndpoint, renderViteHubNitroDevHandler } from "@vite-hub/internal/dev-endpoint"
import { ownModule } from "@vite-hub/internal/build/paths"
import { writeFileIfChanged } from "@vite-hub/internal/definition-catalog"
import type { DurabilityPluginMetadata } from "@vite-hub/internal/durability"
import type { AgentStateDurabilityInput } from "./durability.ts"
import { createNoExternalAddition, createProviderOutputEnvironmentOwner, hasNitroConfigContext, isServerEnvironment, generatedViteHubWatchIgnoredAddition, loadNativePackageModule, loadsViteHubPackagesNatively, renderNativePackageInstallPlugin, resolveViteHubGeneratedRoot, resolveViteHubProjectRoot, VITEHUB_PROJECT_ROOT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import type { ProviderOutputEnvironmentOwner } from "@vite-hub/internal/build/vite"
import { summarizeDefinitions } from "@vite-hub/internal/inspect"
import { getHostingProvider } from "@vite-hub/internal/hosting"
import { wasmSqliteTraceDeps } from "@vite-hub/internal/runtime/sqlite-wasm"
import { isWebContainer } from "@vite-hub/web-container/env"
import { validateWorkspaceDevToken, workspaceDevTokenHeader, workspaceDevTokenServerId } from "@vite-hub/workspace/server"
import { resolveModulePath } from "exsolve"

import {
  agentInvocationsDevGuard,
  agentInvocationsDevRoute,
  agentInvocationsDevRuntimeNamespace,
  agentInvocationsDevRuntimeRoute,
  agentInvocationsDevRuntimeUnavailableCode,
  agentInvocationsDevRuntimeUnavailableMessage,
  agentInvocationsDevTokenServerHeader,
} from "./invocations-dev.ts"
import {
  configureCloudflareAgentState,
  defaultCloudflareAgentStateBinding,
  installCloudflareAgentStateEntrypoint,
} from "./cloudflare.ts"
import { normalizeAgentOptions } from "./config.ts"
import { discoverAgentDefinitions, discoverAgentEvalFiles, discoverAgentOptionsStarts, discoverProcessHostAgentNames, isFolderAgentDefinition } from "./discovery.ts"
import { removeAgentEvaliteConfig, resolveAgentEvalOptions, writeAgentEvaliteConfig } from "./internal/evalite-config.ts"
import { resolveProviderRuntimePackages } from "./internal/provider-runtime-packages.ts"
import { isPortableAgentWorkflowCapability } from "./internal/final-channel-output.ts"
import { agentRouteUsesParam, defaultAgentChatRoute, normalizeAgentRoute } from "./internal/routes.ts"
import { readColocatedAgentInstructions } from "./vite/colocated-agent-instructions.ts"
import { readColocatedAgentSkills, resolveColocatedAgentSkillsRoot } from "./vite/colocated-agent-skills.ts"
import { discoverAgentChannelModules, discoverStandaloneChannels, standaloneChannelWebhookAliases } from "./vite/standalone-channels.ts"
import type { StandaloneChannel } from "./vite/standalone-channels.ts"

function invalidateAgentDevModules(server: ViteDevServer, ids: readonly string[], prefixes: readonly string[] = []): void {
  const matches = (id: string | null) => {
    const normalized = id?.replace(/\\/g, "/")
    return normalized && (ids.includes(normalized) || prefixes.some(prefix => normalized.startsWith(prefix)))
  }
  for (const [id, module] of server.moduleGraph.idToModuleMap) {
    if (matches(id) || matches(module.id)) server.moduleGraph.invalidateModule(module)
  }
  for (const environment of Object.values(server.environments ?? {})) {
    let invalidated = false
    for (const [id, module] of environment.moduleGraph.idToModuleMap) {
      if (matches(id) || matches(module.id)) {
        environment.moduleGraph.invalidateModule(module)
        invalidated = true
      }
    }
    if (invalidated && environment.config.consumer === "server") environment.hot.send({ type: "full-reload" })
  }
}

export { readColocatedAgentSkills } from "./vite/colocated-agent-skills.ts"
export { discoverAgentChannelEnv, discoverAgentGatewayEnv } from "./channel-env-discovery.ts"
export type { AgentChannelEnv } from "./channel-env-discovery.ts"
/** Validates a retention policy at build time, so a ViteHub integration reports a bad limit before it generates output. */
export { normalizeRetention } from "./internal/retention-policy.ts"
export type { NormalizedRetention, RetentionSizeLimit } from "./internal/retention-policy.ts"

import type { Plugin, ResolvedConfig, UserConfig, ViteDevServer } from "vite"
import type { ProviderDeploymentOutputWriter, ProviderOutputCatalog } from "@vite-hub/internal/build/deployment-output"
import type { ViteHubDefinitionSummary, ViteHubInspectionPluginMetadata } from "@vite-hub/internal/inspect"
import type { OperationContributions } from "@vite-hub/internal/operations"
import type { CloudflareAgentStateMigration, CloudflareAgentStateRollupTarget, CloudflareAgentStateTarget } from "./cloudflare.ts"
import type { AgentOptions, DiscoveredAgentDefinition, ResolvedAgentModuleOptions } from "./types.ts"
import { agentDiagnostics } from "./agent-diagnostics.ts"

interface AgentCliContributingPlugin {
  vitehub?: ViteHubInspectionPluginMetadata & DurabilityPluginMetadata & {
    agent?: {
      transformWorkflowRegistry: (code: string, id: string) => string
      /** Checks direct folder Agent imports in a server build that does not run Vite transforms. */
      transformWorkspaceAgent: (code: string, id: string, options: { root: string, serverDirs?: string[] }) => Promise<string | undefined>
      /** The Agent files that a generated Workflow registry imports by path. */
      workflowModules: { index: string, runtimeWorkflow: string, serverInternal: string }
    }
    cli?: unknown
    operations?: OperationContributions
    providerOutput?: {
      prepareSources: (sources: { resolve: (path: string) => string }) => Promise<void>
    }
  }
}

export type AgentVitePlugin = Plugin & AgentCliContributingPlugin & Partial<Pick<ProviderOutputEnvironmentOwner, "nitro">>

// `vite` is an optional peer. Load its parser on demand so this entry stays
// importable without it.
async function parseTypeScript(): Promise<(source: string) => ReturnType<typeof import("vite").parseAst>> {
  const { parseAst } = await import("vite")
  return source => parseAst(source, { lang: "ts" })
}

const agentPackageName = "@vite-hub/agent"

/** A build entry of the Agent package that generated code imports. */
export type AgentRuntimeModule =
  | "cloudflare"
  | "cloudflare/state"
  | "index"
  | "internal/workspace/internal/runtime/hosted"
  | "internal/workspace/internal/runtime/hosted-vercel-blob"
  | "internal/workspace/runtime"
  | "operations"
  | "runtime/invocations-dev"
  | "process"
  | "runtime/workflow"
  | "server"
  | "server/internal"
  | "server/registry"
  | "server/workspace"
  | "state"

/**
 * The absolute path of an Agent build entry. Generated code imports these by path, so they need no package export.
 * In `vite dev`, the `load` hook of `hubAgent()` lets Node load them, so they share the instance that the app imports.
 */
export function agentRuntimeModule(entry: AgentRuntimeModule): string {
  return ownModule(import.meta.url, entry)
}
const providerAgentWorkerStub = /\/runtime\/provider-agent-worker\.[jt]s$/
const agentProcessHostDrainRoute = "/api/_vitehub/host/drain"
const agentProcessHostHealthRoute = "/api/_vitehub/host/health"
const mergeNoExternal = createNoExternalAddition(agentPackageName, "@t3tools/provider-runtime")
const generatedAgentDenoServer = "agent/deno-server.ts"
const generatedAgentDiscordGatewayRouteHandler = "agent/discord-gateway-route.ts"
const generatedAgentDiscordGatewayPlugin = "agent/discord-gateway-plugin.ts"
const generatedAgentWebhookRouteHandler = "agent/chat-webhook-route.ts"
const generatedAgentDeclaredWebhookRouteHandler = "agent/declared-webhook-route.ts"
const generatedAgentPreparationPlugin = "agent/preparation-plugin.ts"
const generatedAgentPreparationHandler = "agent/preparation-route.ts"
/** Readiness route for hosts with a webhook queue and no Workspace preparation. */
const generatedAgentReadyHandler = "agent/ready-route.ts"
const agentReadyRoute = "/api/_vitehub/ready"
const generatedAgentWebhookQueuePlugin = "agent/webhook-queue-plugin.ts"
const webhookQueueStartDelayMs = 1000
const generatedAgentProcessHosts = "agent/process-hosts.ts"
const generatedAgentProcessHostsPlugin = "agent/process-hosts-plugin.ts"
const generatedAgentProcessHostsDrain = "agent/process-hosts-drain.ts"
const generatedAgentProcessHostsHealth = "agent/process-hosts-health.ts"
/** Development-only Nitro handler for `vitehub agent invocations cancel`. Build output never contains it. */
const generatedAgentInvocationsDevHandler = "agent/invocations-dev-handler.ts"
const generatedAgentNetlifyFunction = "agent/netlify-function.mjs"
const generatedAgentEmailRuntime = "agent/email-runtime.js"
const generatedAgentRegistry = "agent/registry.mjs"
const generatedAgentRegistryCatalog = "agent/registry-agents.mjs"
/** Development-only Nitro plugin that installs the generated registry in the Agent package, which Node loads in `vite dev`. */
const generatedAgentRegistryDevPlugin = "agent/registry-dev-plugin.ts"
const agentRegistryId = "#vitehub/agent/registry"
const netlifyAgentFunctionName = "vitehub-agent"
const optionalAskDriverPeer = "advocaat"
const agentPackageRoot = fileURLToPath(new URL("../", import.meta.url)).replace(/\\/g, "/")
// AI gateways import advocaat for ask(); in this workspace the package is a sibling of the Agent package.
const gatewaysPackageRoot = fileURLToPath(new URL("../../gateways/", import.meta.url)).replace(/\\/g, "/")
const optionalAgentRuntimeExternals = [
  "@anthropic-ai/claude-agent-sdk",
  "bufferutil",
  "utf-8-validate",
  "zlib-sync",
]
const nitroAgentRuntimeInlines = ["vite-hub", agentPackageName, "@ai-sdk/mcp", "@t3tools/provider-runtime"]
const optionalNetlifyAgentBundleExternals = [
  "@ai-sdk/mcp",
  "@modelcontextprotocol/sdk/*",
  "@vite-hub/kv",
  "@vite-hub/sandbox/task",
  "@vite-hub/sandbox/task/*",
  "@vite-hub/shell",
  "@vite-hub/shell/*",
  "@vite-hub/workflow",
  "@vite-hub/workflow/*",
  "agents",
  "evalite/*",
  ...optionalAgentRuntimeExternals,
  "vitest/*",
]

// The ChatGPT model is the only Agent module that imports @ai-sdk/openai.
const chatgptModelProvider = "@ai-sdk/openai"
const chatgptModelProviderWithoutConnections = "\0vitehub-agent:chatgpt-model-provider-without-connections"

function isAgentModule(importer: string | undefined): boolean {
  if (!importer) return false
  const normalized = importer.replace(/\\/g, "/")
  return normalized.includes("/node_modules/@vite-hub/agent/") || normalized.startsWith(agentPackageRoot)
}

function isAgentPackageImporter(importer: string | undefined): boolean {
  if (!importer) return false
  const normalized = importer.replace(/\\/g, "/")
  return isAgentModule(importer)
    || normalized.includes("/node_modules/@vite-hub/gateways/")
    || normalized.startsWith(gatewaysPackageRoot)
}

function resolveNetlifyAgentBundleExternals(options: AgentGeneratedImportOptions): string[] {
  const bundled = new Set<string>()
  if (options.runtimeCapabilities?.some(capability => capability.name === "kv" && capability.packageName !== false)) {
    bundled.add("@vite-hub/kv")
  }
  if (options.workflowModules) {
    bundled.add("@vite-hub/workflow")
    bundled.add("@vite-hub/workflow/*")
  }
  if (options.workspaceDependencyRuntimeImports?.sandboxTask || options.workspaceDependencyRuntimeImports?.sandboxTaskRuntimeState) {
    bundled.add("@vite-hub/sandbox/task")
    bundled.add("@vite-hub/sandbox/task/*")
  }
  if (options.workspaceDependencyRuntimeImports?.shellWorkspace) {
    bundled.add("@vite-hub/shell")
    bundled.add("@vite-hub/shell/*")
  }
  return optionalNetlifyAgentBundleExternals.filter(specifier => !bundled.has(specifier))
}

interface InternalAgentModuleOptions extends AgentOptions {
  /** The specifier that generated code uses to import the KV package. */
  kvImport?: string
  processDiscordGateway?: boolean
  providerImportAliases?: Record<string, string>
  runtimeCapabilityImports?: Record<string, false | string>
  /** The Workflow modules that generated code loads, when Workflow is on. */
  workflowModules?: AgentWorkflowModules
  workspaceDependencyRuntimeImports?: WorkspaceDependencyRuntimeImports
}

/** The Workflow modules that generated Agent code loads: the public root and the runtime state file. */
export interface AgentWorkflowModules {
  index: string
  state: string
}

interface AgentGeneratedImportOptions {
  denoCronImport?: string
  providerImportAliases?: Record<string, string>
  runtimeCapabilities?: GeneratedAgentRuntimeCapability[]
  sourceRootDir?: string
  standaloneChannels?: readonly StandaloneChannel[]
  workflowModules?: AgentWorkflowModules
  workspaceDependencyRuntimeImports?: WorkspaceDependencyRuntimeImports
}

interface WorkspaceDependencyRuntimeImports {
  sandboxTask?: string
  sandboxTaskRuntimeState?: string
  shellWorkspace?: string
}

interface GeneratedAgentRuntimeCapability {
  importName: string
  name: string
  packageName: false | string
  pluginName: string
}

interface GeneratedAgentRuntimeCapabilityDefinition extends GeneratedAgentRuntimeCapability {
  /** Reads the module from the owning plugin, for primitives that an application file defines. Undefined omits the primitive. */
  modulePath?: (plugin: Plugin, projectRoot: string | undefined) => string | undefined
}

/** The project root that ViteHub plugins key generated state by. Nuxt sets it explicitly. */
function viteHubProjectRoot(config: { root?: string }): string {
  const configured: unknown = Reflect.get(config, VITEHUB_PROJECT_ROOT)
  return typeof configured === "string" && configured ? resolve(configured) : resolveViteHubProjectRoot(resolve(config.root || process.cwd()))
}

/** The Content runtime is the default export of the `server/content.ts` file that the Source plugin discovered. */
function contentDefinitionPath(plugin: Plugin, projectRoot: string | undefined): string | undefined {
  const api: unknown = Reflect.get(Object(plugin), "api")
  const getContentDefinition: unknown = Reflect.get(Object(api), "getContentDefinition")
  if (!(getContentDefinition instanceof Function)) return
  const definition: unknown = getContentDefinition(projectRoot)
  const handler: unknown = Reflect.get(Object(definition), "handler")
  return typeof handler === "string" && handler ? handler.replace(/\\/g, "/") : undefined
}

async function prepareSourceDefinitions(config: ResolvedConfig, projectRoot: string, serverDirs: string[] | undefined): Promise<void> {
  const sourcePlugin = (config.plugins ?? []).flat(Infinity).find(plugin => plugin.name === "@vite-hub/source/vite")
  const api: unknown = Reflect.get(Object(sourcePlugin), "api")
  const prepareSources: unknown = Reflect.get(Object(api), "prepareSources")
  if (!(prepareSources instanceof Function)) return
  await prepareSources({ projectRoot, serverDirs })
}

const generatedAgentRuntimeCapabilityDefinitions: GeneratedAgentRuntimeCapabilityDefinition[] = [
  { importName: "agentAuth", name: "auth", packageName: "@vite-hub/auth/agent", pluginName: "@vite-hub/auth/vite" },
  { importName: "blob", name: "blob", packageName: "@vite-hub/blob", pluginName: "@vite-hub/blob/vite" },
  { importName: "connections", name: "connections", packageName: "@vite-hub/connections/server", pluginName: "@vite-hub/connections/vite" },
  { importName: "console", name: "console", packageName: "vite-hub/console/server", pluginName: "vite-hub/console" },
  { importName: "default", modulePath: contentDefinitionPath, name: "content", packageName: false, pluginName: "@vite-hub/source/vite" },
  { importName: "agentDb", name: "db", packageName: "@vite-hub/database/runtime/registry", pluginName: "@vite-hub/database/vite" },
  { importName: "email", name: "email", packageName: "@vite-hub/email", pluginName: "@vite-hub/email/vite" },
  { importName: "agentI18n", name: "i18n", packageName: "@vite-hub/i18n/server", pluginName: "@vite-hub/i18n/vite" },
  { importName: "kv", name: "kv", packageName: "@vite-hub/kv", pluginName: "@vite-hub/kv/vite" },
]

function configuredGeneratedAgentRuntimeCapabilities(
  plugins: readonly Plugin[],
  packageImports: Record<string, false | string> = {},
  projectRoot?: string,
): GeneratedAgentRuntimeCapability[] {
  const pluginNames = new Set(plugins.map(plugin => plugin.name))
  return generatedAgentRuntimeCapabilityDefinitions.flatMap(({ modulePath, ...capability }) => {
    if (modulePath) {
      // An application-defined primitive exists only when its plugin found the file. `false` disables it.
      const plugin = plugins.find(candidate => candidate.name === capability.pluginName)
      const packageName = packageImports[capability.name] ?? (plugin ? modulePath(plugin, projectRoot) : undefined)
      return packageName ? [{ ...capability, packageName }] : []
    }
    if (!pluginNames.has(capability.pluginName) && packageImports[capability.name] !== false) return []
    return [{
      ...capability,
      packageName: packageImports[capability.name] === false && pluginNames.has(capability.pluginName)
        ? capability.packageName
        : packageImports[capability.name] ?? capability.packageName,
    }]
  })
}

/**
 * Whether the generated ESM module at `importer` can import `specifier`. This uses Node resolution, not
 * `config.createResolver()`: `configResolved` runs before Vite creates its environments, and plugins
 * such as vite-plugin-inspect (Nuxt DevTools) wrap that resolver and throw without an environment.
 */
function canImportFrom(importer: string, specifier: string, aliases: ResolvedConfig["resolve"]["alias"], conditions: string[]): boolean {
  // Keep explicit aliases eligible: Vite may resolve a source file or virtual module that Node cannot.
  // In particular, customResolver hooks must wait until Vite loads the generated route.
  if (aliases.some(({ find }) => typeof find === "string" ? specifier === find || specifier.startsWith(`${find}/`) : find.test(specifier))) return true
  return resolveModulePath(specifier, { cache: false, conditions, from: pathToFileURL(importer), try: true }) !== undefined
}

function resolveGeneratedAgentRuntimeCapabilities(
  config: Pick<ResolvedConfig, "plugins" | "root"> & { isProduction?: boolean; resolve?: Pick<ResolvedConfig["resolve"], "alias" | "conditions"> },
  packageImports: Record<string, false | string> = {},
): GeneratedAgentRuntimeCapability[] {
  const candidates = configuredGeneratedAgentRuntimeCapabilities(config.plugins || [], packageImports, viteHubProjectRoot(config))
  const importer = join(resolveViteHubGeneratedRoot(config), "agent", "runtime-capabilities.js")
  const aliases = config.resolve?.alias ?? []
  const conditions = ["import", ...(config.resolve?.conditions ?? ["node"])].map(condition => condition === "development|production" ? config.isProduction ? "production" : "development" : condition)
  return candidates.filter(capability => capability.packageName === false || canImportFrom(importer, capability.packageName, aliases, conditions))
}

function generatedAgentRuntimeCapabilityAlias(capability: GeneratedAgentRuntimeCapability): string {
  return `vitehub${capability.name[0]!.toUpperCase()}${capability.name.slice(1)}`
}

function generatedAgentRuntimeCapabilityImports(capabilities: GeneratedAgentRuntimeCapability[]): string[] {
  return capabilities.flatMap(capability => capability.packageName === false
    ? []
    : [`import { ${capability.importName} as ${generatedAgentRuntimeCapabilityAlias(capability)} } from ${JSON.stringify(capability.packageName)}`])
}

function generatedAgentRuntimeCapabilities(capabilities: GeneratedAgentRuntimeCapability[]): string {
  const entries = capabilities.map(capability =>
    `${capability.name}: ${capability.packageName === false ? "false" : generatedAgentRuntimeCapabilityAlias(capability)}`
  )
  return `{ ${entries.join(", ")} }`
}

async function writeStandaloneAgentRuntimeCapabilities(
  config: Pick<ResolvedConfig, "plugins" | "root">,
  capabilities: GeneratedAgentRuntimeCapability[],
): Promise<GeneratedAgentRuntimeCapability[]> {
  // The generated Deno and Netlify route modules are host runtimes too. Keep
  // their full capability record available to standalone handlers.
  const standaloneCapabilities = capabilities
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
  await writeFileIfChanged(runtimePath, [
    `import { createEmail } from ${JSON.stringify(emailImport)}`,
    `import definition from ${JSON.stringify(moduleImportSpecifier(runtimePath, definition.handler))}`,
    "export const email = createEmail(definition)",
    "",
  ].join("\n"))
  return standaloneCapabilities.map(capability => capability === emailCapability
    ? { ...capability, packageName: "./email-runtime.js" }
    : capability)
}

function getInternalAgentOptions(options: AgentOptions | false | undefined): InternalAgentModuleOptions | undefined {
  return options && typeof options === "object" ? options as InternalAgentModuleOptions : undefined
}

function getProviderImportAliases(
  options: AgentOptions | false | undefined,
  fallback?: InternalAgentModuleOptions,
): Record<string, string> | undefined {
  return getInternalAgentOptions(options)?.providerImportAliases ?? fallback?.providerImportAliases
}

function generatedAgentWorkflowCapabilityLoaders(
  capabilities: GeneratedAgentRuntimeCapability[],
  includeCapabilityImports = true,
) {
  const portableCapabilities = capabilities.filter(capability =>
    capability.packageName !== false && isPortableAgentWorkflowCapability(capability.name),
  )
  if (!portableCapabilities.length) return { imports: [] as string[], setup: [] as string[] }
  return {
    imports: [
      ...(includeCapabilityImports ? generatedAgentRuntimeCapabilityImports(portableCapabilities) : []),
      `import { setAgentWorkflowCapabilityLoaders as vitehubSetAgentWorkflowCapabilityLoaders } from ${JSON.stringify(agentRuntimeModule("server/internal"))}`,
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
  state: { cloudflare?: boolean, libsql?: GeneratedLibsqlAgentStateOptions } = {},
): string {
  const capabilityLoaders = generatedAgentWorkflowCapabilityLoaders(capabilities)
  const stateImports = state.libsql
    ? [
        `import { createLibsqlAgentState } from ${JSON.stringify(agentRuntimeModule("state"))}`,
        `import { setAgentChannelDeliveryWorkflowStateResolver } from ${JSON.stringify(agentRuntimeModule("server/internal"))}`,
      ]
    : state.cloudflare
      ? [
          `import { createCloudflareAgentState, getActiveCloudflareEnv } from ${JSON.stringify(agentRuntimeModule("cloudflare"))}`,
          `import { setAgentChannelDeliveryWorkflowStateResolver } from ${JSON.stringify(agentRuntimeModule("server/internal"))}`,
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
  // Nuxt writes this registry from its Nitro config hook before Vite resolves the host preset,
  // and the Vite transform runs again on that file. The latest call owns the setup block.
  const registry = stripGeneratedAgentWorkflowRegistrySetup(code)
  if (!capabilityLoaders.imports.length && !stateImports.length) return registry
  return [
    generatedAgentWorkflowRegistrySetupStart,
    ...capabilityLoaders.imports,
    ...stateImports,
    "",
    ...capabilityLoaders.setup,
    ...stateSetup,
    generatedAgentWorkflowRegistrySetupEnd,
    registry,
  ].join("\n")
}

const generatedAgentWorkflowRegistrySetupStart = "// @vite-hub/agent workflow registry setup start"
const generatedAgentWorkflowRegistrySetupEnd = "// @vite-hub/agent workflow registry setup end"

function stripGeneratedAgentWorkflowRegistrySetup(code: string): string {
  if (!code.startsWith(`${generatedAgentWorkflowRegistrySetupStart}\n`)) return code
  const end = code.indexOf(`\n${generatedAgentWorkflowRegistrySetupEnd}\n`)
  return end === -1 ? code : code.slice(end + generatedAgentWorkflowRegistrySetupEnd.length + 2)
}

function isGeneratedAgentWorkflowRegistryId(id: string): boolean {
  const normalizedId = id.replaceAll("\\", "/")
  return normalizedId.includes("/.vitehub/") && normalizedId.endsWith("/workflow/registry-runtime.mjs")
}


function getWorkflowModules(options: AgentOptions | false | undefined, fallback?: InternalAgentModuleOptions): AgentWorkflowModules | undefined {
  return getInternalAgentOptions(options)?.workflowModules ?? fallback?.workflowModules
}

function getWorkspaceDependencyRuntimeImports(
  options: AgentOptions | false | undefined,
  fallback?: InternalAgentModuleOptions,
): WorkspaceDependencyRuntimeImports | undefined {
  return getInternalAgentOptions(options)?.workspaceDependencyRuntimeImports ?? fallback?.workspaceDependencyRuntimeImports
}

function generatedAgentRouteCapabilities(options: AgentGeneratedImportOptions) {
  const runtimeCapabilities = options.runtimeCapabilities ?? []
  if (!runtimeCapabilities.length) return { imports: [] as string[], requestOption: "", requestProperty: "", setup: [] as string[] }
  const workflowCapabilityLoaders = generatedAgentWorkflowCapabilityLoaders(
    runtimeCapabilities,
    false,
  )
  return {
    imports: [
      ...generatedAgentRuntimeCapabilityImports(runtimeCapabilities),
      ...workflowCapabilityLoaders.imports,
      `import { setAgentHostCapabilities as vitehubSetAgentHostCapabilities } from ${JSON.stringify(agentRuntimeModule("server/internal"))}`,
    ],
    requestOption: "capabilities: vitehubAgentRouteCapabilities, ",
    requestProperty: ", capabilities: vitehubAgentRouteCapabilities",
    setup: [
      `const vitehubAgentRouteCapabilities = ${generatedAgentRuntimeCapabilities(runtimeCapabilities)}`,
      "// A standalone runAgent(), such as one in a Schedule handler, gets the same capabilities as these routes.",
      "vitehubSetAgentHostCapabilities(vitehubAgentRouteCapabilities)",
      "",
      ...workflowCapabilityLoaders.setup,
    ],
  }
}

/** Discovers `*.agent.ts` files and `server/agents` definitions once per Agent name. */
function discoverProjectAgentDefinitions(root: string, serverDirs = [join(root, "server")]): DiscoveredAgentDefinition[] {
  const definitions = [
    ...discoverAgentDefinitions({ mode: "vite-suffix", rootDir: root }),
    ...discoverAgentDefinitions({ mode: "server-agents", scanDirs: serverDirs }),
  ]
  const unique = new Map<string, DiscoveredAgentDefinition>()
  for (const definition of definitions) {
    const existing = unique.get(definition.name)
    if (existing && existing.handler !== definition.handler) {
      throw agentDiagnostics.AGENT_B0002({ message: `[vitehub] Duplicate Agent name "${definition.name}" in ${existing.handler} and ${definition.handler}. Give each Agent a unique name.` })
    }
    unique.set(definition.name, definition)
  }
  return [...unique.values()]
}

/** Lists each discovered Agent Definition with its name and file. Vite Doctor rules read it. */
export function listAgentDefinitionFiles(root: string, serverDirs?: string[]): { name: string, handler: string }[] {
  return discoverProjectAgentDefinitions(root, serverDirs).map(({ name, handler }) => ({ name, handler }))
}

async function isColocatedAgentInstructionDependency(root: string, file: string, serverDirs?: string[]): Promise<boolean> {
  const target = resolve(file)
  for (const definition of discoverProjectAgentDefinitions(root, serverDirs)) {
    const dependencies = new Set<string>()
    await readColocatedAgentInstructions(definition.handler, { dependencies })
    if (dependencies.has(target)) return true
  }
  return false
}

function hasHostedAgentDefinitions(root: string, serverDirs = [join(root, "server")], standaloneChannels = discoverStandaloneChannels(root, serverDirs)): boolean {
  return discoverAgentDefinitions({
    mode: "server-agents",
    scanDirs: serverDirs,
  }).length > 0 || standaloneChannels.some(channel => channel.inbound)
}

function generatedAgentWorkflowRuntime(options: AgentGeneratedImportOptions) {
  if (!options.workflowModules) return { imports: [] as string[], setup: [] as string[] }
  return {
    imports: [`import { setAgentWorkflowRuntimeLoaders as vitehubSetAgentWorkflowRuntimeLoaders } from ${JSON.stringify(agentRuntimeModule("server/internal"))}`],
    setup: [
      "vitehubSetAgentWorkflowRuntimeLoaders({",
      `  state: () => import(${JSON.stringify(options.workflowModules.state)}),`,
      `  workflow: () => import(${JSON.stringify(options.workflowModules.index)}),`,
      "})",
      "",
    ],
  }
}

function generatedAgentWorkspaceDependencyRuntime(options: AgentGeneratedImportOptions) {
  const imports = options.workspaceDependencyRuntimeImports
  if (!imports) return { imports: [] as string[], setup: [] as string[] }
  return {
    imports: [`import { setWorkspaceDependencyRuntimeLoaders as vitehubSetWorkspaceDependencyRuntimeLoaders } from ${JSON.stringify(agentRuntimeModule("internal/workspace/runtime"))}`],
    setup: [
      "vitehubSetWorkspaceDependencyRuntimeLoaders({",
      ...(imports.sandboxTask ? [`  sandboxTask: () => import(${JSON.stringify(imports.sandboxTask)}),`] : []),
      ...(imports.sandboxTaskRuntimeState ? [`  sandboxTaskRuntimeState: () => import(${JSON.stringify(imports.sandboxTaskRuntimeState)}),`] : []),
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
type GeneratedLibsqlAgentStateOptions = Pick<ResolvedAgentModuleOptions["providers"]["state"], "journalMode" | "tablePrefix" | "url"> & {
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

// pkce-challenge, a dependency of @ai-sdk/mcp, exports only "browser" and "node" conditions, so Worker
// conditions cannot resolve it. Its browser build uses only Web Crypto, which Workers provide.
function resolveWorkerPackageAliases(): Record<string, string> {
  try {
    const requireFromMcp = createRequire(createRequire(import.meta.url).resolve("@ai-sdk/mcp/package.json"))
    const browserEntry = join(dirname(requireFromMcp.resolve("pkce-challenge")), "index.browser.js")
    return existsSync(browserEntry) ? { "pkce-challenge": browserEntry } : {}
  }
  catch {
    // @ai-sdk/mcp is optional. Without it, the Worker bundle does not import pkce-challenge.
    return {}
  }
}

function shouldInstallCloudflareAgentState(
  options: false | ResolvedAgentModuleOptions,
  config: unknown,
  command?: "build" | "serve",
): options is ResolvedAgentModuleOptions {
  if (!options) return false
  const { driver, url } = options.providers.state
  if (driver === "cloudflare" || driver === "cloudflare-agents") return true
  if (driver !== "auto") return false
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
  const { authToken, driver, journalMode, tablePrefix, url } = options.providers.state
  const auto = driver === "auto"
  if (!auto && driver !== "sqlite" && driver !== "libsql") return
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
    throw agentDiagnostics.AGENT_B0005({ message: `[vitehub] Agent state cannot use a file: URL on ${ephemeralHosting} because its filesystem is ephemeral. Configure a durable libSQL URL.` })
  }
  return {
    ...(authTokenEnvName ? { authTokenEnvName } : {}),
    ...(!resolvedUrl ? { durableUrlRequired: true } : {}),
    ...(ephemeralHosting ? { ephemeralHosting } : {}),
    ...(journalMode ? { journalMode } : {}),
    ...(tablePrefix ? { tablePrefix } : {}),
    ...(resolvedUrl ? { url: resolvedUrl } : {}),
  }
}

/** The Agent state store for the durability report. A remote URL becomes `remote`, so no credential reaches the server bundle. */
function agentStateDurabilityInput(options: ResolvedAgentModuleOptions, config: unknown, cloudflare: boolean): AgentStateDurabilityInput | undefined {
  if (cloudflare) return { provider: "cloudflare" }
  const { driver } = options.providers.state
  if (driver === "memory") return { provider: "memory" }
  const libsql = resolveLibsqlAgentState(options, config)
  if (!libsql) return
  return { provider: "libsql", ...(libsql.url ? { url: sqliteUrlInput(libsql.url) } : {}) }
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
    // SAFETY: The preceding runtime check proves this Rollup external is the function member of the union.
    const externalFunction = external as RollupExternalFunction
    return (source: string, importer?: string, isResolved?: boolean) =>
      additions.includes(source) || Boolean(externalFunction(source, importer, isResolved))
  }
  return external
}

function mergeCloudflareWorkersExternal(external: RollupExternalOption | undefined): RollupExternalOption | undefined {
  return mergeRollupExternals(external, ["cloudflare:workers", ...optionalAgentRuntimeExternals])
}

function mergeBuildExternal(config: BuildWithRolldownOptions, additions: readonly string[]): BuildWithRolldownOptions["build"] {
  const build = config.build ?? {}
  const configuredExternal = build.rolldownOptions?.external
  const external = typeof configuredExternal === "string" || configuredExternal instanceof RegExp ? [configuredExternal] : configuredExternal
  if (Array.isArray(external)) {
    const supportedExternal = external.filter((entry): entry is string | RegExp => typeof entry === "string" || entry instanceof RegExp)
    if (build.rolldownOptions) build.rolldownOptions.external = supportedExternal
    return {
      rolldownOptions: {
        external: additions.filter(source => !supportedExternal.includes(source)),
      },
    }
  }
  return {
    rolldownOptions: {
      external: mergeRollupExternals(configuredExternal, additions),
    },
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

  // SAFETY: The clone retains NitroConfig fields and only copies nested configuration objects and arrays.
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
  if (isRecord(nitro.rollupConfig) && Array.isArray(nitro.rollupConfig.external)) {
    nitro.rollupConfig.external = nitro.rollupConfig.external.filter(
      (entry): entry is string | RegExp => typeof entry === "string" || entry instanceof RegExp,
    )
  }
  const externals = isRecord(nitro.externals) ? { ...nitro.externals } : {}
  const existingInline = Array.isArray(externals.inline) ? externals.inline : []
  externals.inline = externals.inline === true
    ? true
    : [...new Set([...existingInline, ...nitroAgentRuntimeInlines])]
  nitro.externals = externals
  if (isWebContainer()) {
    const existingTraceDeps = Array.isArray(nitro.traceDeps) ? nitro.traceDeps : []
    nitro.traceDeps = [...new Set([...existingTraceDeps, ...wasmSqliteTraceDeps])]
  }
  const existingNoExternals = Array.isArray(nitro.noExternals) ? nitro.noExternals : []
  nitro.noExternals = nitro.noExternals === true
    ? true
    // Keep the provider's Effect dependencies together so Nitro does not emit
    // platform chunks with unresolved Effect peer imports in the Node output.
    : [...new Set([...existingNoExternals, "@t3tools/provider-runtime", "effect", "@effect/platform-node", "@effect/platform-node-shared"])]
  nitro.rollupConfig ||= {}
  // SAFETY: Nitro forwards this field to Rolldown, whose external option accepts the shared Rollup shape.
  const existingExternal = nitro.rollupConfig.external as RollupExternalOption | undefined
  nitro.rollupConfig.external = mergeRollupExternals(
    existingExternal,
    optionalAgentRuntimeExternals,
  )
  return nitro
}

function mergeNitroHandlers(nitro: NitroConfig, handlers: Array<{ handler: string, route: string }>): NitroConfig {
  if (handlers.length === 0) return nitro
  const existingHandlers = Array.isArray(nitro.handlers) ? nitro.handlers : []
  return {
    ...nitro,
    // Nitro imports a lazy handler on its first request. The Agent runtime and the Agent Definitions then do not load
    // at server startup, which is Worker startup on Cloudflare.
    handlers: [...existingHandlers, ...handlers.map(handler => ({ ...handler, lazy: true }))],
  }
}

function guardAgentDevelopmentRoutes(nitro: NitroConfig, handlers: Array<{ route: string }>): NitroConfig {
  if (!handlers.length) return nitro
  const modules = Array.isArray(nitro.modules) ? nitro.modules : []
  return {
    ...nitro,
    modules: [...modules, {
      name: "vite-hub/agent-development-route-guard",
      setup(runtime: {
        hooks: { hook: (name: "build:before", callback: () => void) => void }
        scannedHandlers: Array<{ route?: string, middleware?: boolean }>
      }) {
        runtime.hooks.hook("build:before", () => {
          const scanned = runtime.scannedHandlers.flatMap(handler =>
            typeof handler.route === "string" ? [{ route: handler.route, middleware: handler.middleware }] : [])
          for (const handler of handlers) validateAgentStaticRoute(handler.route, scanned, "development invocation", agentInvocationsDevRuntimeNamespace)
        })
      },
    }],
  }
}

function mergeNitroPlugins(nitro: NitroConfig, plugins: string[], bootstrap?: string): NitroConfig {
  if (plugins.length === 0 && !bootstrap) return nitro
  const existingPlugins = Array.isArray(nitro.plugins) ? nitro.plugins : []
  return { ...nitro, plugins: [...(bootstrap ? [bootstrap] : []), ...existingPlugins.filter(plugin => plugin !== bootstrap), ...plugins] }
}

function installAgentProviderRuntimePackages(nitro: NitroConfig, rootDir: string): NitroConfig {
  const modules = Array.isArray(nitro.modules) ? nitro.modules : []
  return {
    ...nitro,
    modules: [createAgentProviderRuntimePackagesNitroModule(rootDir), ...modules],
  }
}

function createAgentProviderRuntimePackagesNitroModule(rootDir: string): (nitro: {
  hooks: { hook: (name: "compiled", callback: () => Promise<void>) => void }
  options: { dev?: boolean, output: { serverDir: string }, preset?: string | null }
}) => void {
  return (nitro) => {
    if (nitro.options.dev !== false || deploymentPresetFromNitro(nitro.options.preset) !== "node") return
    nitro.hooks.hook("compiled", async () => {
      const packages = resolveProviderRuntimePackages({ rootDir })
      if (!packages.length) return
      await copyNodeRuntimePackages({
        outputNodeModules: join(nitro.options.output.serverDir, "node_modules"),
        packages,
        rootDir,
      })
    })
  }
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

/** Like `routeRegexSource()`, but matches the end of a pathname, so a base URL before the route does not change the match. */
function routeSuffixRegexSource(route: false | string | undefined, captureParams: string[] = []): string {
  const source = routeRegexSource(route, captureParams)
  return source.startsWith("^") ? source.slice(1) : source
}

function routeUsesParam(route: false | string | undefined, param: string): boolean {
  return agentRouteUsesParam(route, param)
}

function agentRoutesOverlap(left: string, right: string): boolean {
  const leftSegments = normalizeAgentRoute(left).split("/")
  const rightSegments = normalizeAgentRoute(right).split("/")
  return leftSegments.length === rightSegments.length && leftSegments.every((segment, index) => {
    const other = rightSegments[index]!
    return segment === other || segment.startsWith(":") || other.startsWith(":")
  })
}

function validateInspectionRoute(routes: ResolvedAgentModuleOptions["routes"]): void {
  if (!routes.inspection) return
  const conflictingRoute = [defaultAgentChatRoute, routes.webhooks, routes.discordGateway]
    .find(route => route && agentRoutesOverlap(routes.inspection as string, route))
  if (conflictingRoute) {
    throw agentDiagnostics.AGENT_B0006({ message: `[vitehub] Agent inspection route conflicts with the generated route ${JSON.stringify(conflictingRoute)}.` })
  }
}

function generatedWebhookRoute(route: false | string | undefined): string {
  return route ? normalizeNitroRoute(route) : ""
}

function isNetlifyHosting(config: ResolvedConfig): boolean {
  return resolveAgentHosting(config) === "netlify"
}

function resolveStringAliases(config: ResolvedConfig): Record<string, string> {
  return encodeProviderOutputAliases(config.resolve.alias)
}

function resolveColocatedAgentWorkspaceRoot(file: string): string | undefined {
  const workspaceDirectory = join(dirname(file), "workspace")
  return existsSync(workspaceDirectory) && statSync(workspaceDirectory).isDirectory()
    ? workspaceDirectory
    : undefined
}

function resolveWorkspaceSourceRoot(file: string): string {
  return resolveColocatedAgentWorkspaceRoot(file) ?? dirname(file)
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
    "  const skillsSymbol = Symbol.for('vitehub.agent.colocatedSkills')",
    "  const setDiscoveredSkills = Reflect.get(agent, Symbol.for('vitehub.agent.discoveredSkillsSetter'))",
    "  if (typeof setDiscoveredSkills === 'function') setDiscoveredSkills(skills)",
    "  if (!Object.keys(skills).length && !Object.getOwnPropertyDescriptor(agent, skillsSymbol)?.get) Reflect.deleteProperty(agent, skillsSymbol)",
    `  const resolvedAgent = ${typescript ? "(" : ""}Object.keys(skills).length ? Object.create(Object.getPrototypeOf(agent), Object.getOwnPropertyDescriptors(agent)) : agent${typescript ? ") as Agent & Partial<WorkspaceAgentDefinition>" : ""}`,
    "  const sourceSymbol = Symbol.for('vitehub.agent.definitionSource')",
    "  if (resolvedAgent !== agent) Object.defineProperty(resolvedAgent, sourceSymbol, { configurable: true, value: agent })",
    "  const currentSkillsGetter = Object.getOwnPropertyDescriptor(agent, skillsSymbol)?.get",
    "  const updateSymbol = Symbol.for('vitehub.agent.discoveredSkillsUpdate')",
    "  const updateSkills = currentSkillsGetter && Reflect.get(currentSkillsGetter, updateSymbol)",
    "  if (typeof updateSkills === 'function') updateSkills(skills)",
    "  if (Object.keys(skills).length && typeof setDiscoveredSkills !== 'function' && typeof updateSkills !== 'function') {",
    "    // Skills extend by name. A Skill folder of this Agent replaces the inherited folder with the same name, including its references.",
    "    // Read the inherited Skills when the Agent runs, because the registry can load this Agent before its parent.",
    "    const inheritedSkills = Object.getOwnPropertyDescriptor(agent, skillsSymbol)?.get",
    `    const skillName = (source${typescript ? ": unknown" : ""}) => {`,
    "      const path = source && typeof source === 'object' ? Reflect.get(source, 'workspacePath') : undefined",
    "      return typeof path === 'string' ? path.split('/')[2] : undefined",
    "    }",
    "    let localSkills = skills",
    "    const update = (sources" + (typescript ? ": typeof skills | undefined" : "") + ") => { localSkills = sources || {} }",
    "    const extendedSkills = () => {",
    "      const inherited = inheritedSkills?.call(agent)",
    "      const ownSkillNames = new Set(Object.values(localSkills).map(skillName))",
    "      return { ...Object.fromEntries(Object.entries(inherited && typeof inherited === 'object' ? inherited : {}).filter(([, source]) => !ownSkillNames.has(skillName(source)))), ...localSkills }",
    "    }",
    "    Object.defineProperty(extendedSkills, updateSymbol, { value: update })",
    "    const descriptor = inheritedSkills ? { configurable: true, enumerable: true, get: extendedSkills } : { configurable: true, enumerable: true, value: skills }",
    "    Object.defineProperty(agent, skillsSymbol, descriptor)",
    "    if (resolvedAgent !== agent) {",
    "      Object.defineProperty(resolvedAgent, skillsSymbol, descriptor)",
    "    }",
    "  }",
    "  const options = resolvedAgent?.__vitehubWorkspaceAgentOptions",
    "  const workspace = options?.workspace",
    "  if (!workspace || typeof workspace !== 'object' || (Object.hasOwn(workspace, 'name') && typeof workspace.name === 'string')) return resolvedAgent",
    "  const existingSources = resolvedAgent.sources && typeof resolvedAgent.sources === 'object' ? resolvedAgent.sources : undefined",
    "  // A Provider Driver writes the bundled Skills and instructions into its working directory itself.",
    "  const storesBundledFiles = Reflect.get(resolvedAgent, Symbol.for('vitehub.baseAgentDriverKind')) !== 'provider'",
    `  const providerInstructions = ${typescript ? "(" : ""}Reflect.get(resolvedAgent, Symbol.for('vitehub.baseAgentDriver'))${typescript ? " as { instructions?: unknown } | undefined)" : ""}?.instructions`,
    "  const retainedExistingSources = storesBundledFiles ? existingSources : Object.fromEntries(Object.entries(existingSources || {}).filter(([key]) => (key === '__vitehubAgentInstructions' ? providerInstructions === undefined : !key.startsWith('__vitehubAgentSkill:'))))",
    "  const sources = {",
    "    ...retainedExistingSources,",
    "    ...(storesBundledFiles && colocatedInstructions ? { __vitehubAgentInstructions: { content: colocatedInstructions, materialize: 'startup', mount: '', workspacePath: 'AGENTS.md' } } : {}),",
    "    ...(storesBundledFiles ? Reflect.get(resolvedAgent, skillsSymbol) : {}),",
    "    ...(storesBundledFiles ? workspace.sources : Object.fromEntries(Object.entries(workspace.sources || {}).filter(([key]) => key !== '__vitehubAgentInstructions' && !key.startsWith('__vitehubAgentSkill:')))),",
    "  }",
    "  const resolvedSources = Object.keys(sources).length ? sources : undefined",
    "  const resolvedSourceRootDir = workspace.sourceRootDir ?? resolvedAgent.sourceRootDir ?? sourceRootDir",
    `  const workspaceOptions = { ...options, workspace: { ...workspace, ...(resolvedSources ? { sources: resolvedSources } : {}), sourceRootDir: resolvedSourceRootDir } }${typescript ? " as WorkspaceAgentOptions" : ""}`,
    `  const decoratedAgent = { ...resolvedAgent, ...${workspaceDefinitionFromOptions}(workspaceOptions), __vitehubWorkspaceAgentOptions: workspaceOptions }`,
    "  for (const key of Reflect.ownKeys(resolvedAgent)) {",
    `    if (key === skillsSymbol || !Object.prototype.propertyIsEnumerable.call(resolvedAgent, key)) Object.defineProperty(decoratedAgent, key, Object.getOwnPropertyDescriptor(resolvedAgent, key)${typescript ? "!" : ""})`,
    "  }",
    "  Object.defineProperty(decoratedAgent, sourceSymbol, { configurable: true, value: resolvedAgent })",
    `  const sourceDefaults = Object.fromEntries(Object.entries(sources).filter(([key, source]) => source !== workspace.sources?.[key] && source !== existingSources?.[key]))${typescript ? " as NonNullable<Exclude<WorkspaceAgentOptions['workspace'], string | { name: string }>['sources']>" : ""}`,
    "  inheritAgentLayerOptions(resolvedAgent, decoratedAgent, { workspace: { sourceRootDir, ...(Object.keys(sourceDefaults).length ? { sources: sourceDefaults } : {}) } })",
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

interface DiscoveredAgentExportDecorator {
  decorate: (value: string) => string
  imports: string[]
}

function colocatedAgentSkillsDecorator(
  skills: NonNullable<ReturnType<typeof readColocatedAgentSkills>>,
): DiscoveredAgentExportDecorator {
  return {
    decorate: value => `vitehubWithColocatedAgentSkills(${value}, vitehubDecodeColocatedAgentSkills(${JSON.stringify(skills)}))`,
    imports: [`import { decodeColocatedAgentSkills as vitehubDecodeColocatedAgentSkills, withColocatedAgentSkills as vitehubWithColocatedAgentSkills } from ${JSON.stringify(agentRuntimeModule("server/internal"))}`],
  }
}

/** The name and Workspace arguments that mark a discovered Agent with its host identity. */
function discoveredAgentIdentityArguments(definition: DiscoveredAgentDefinition): string {
  return [definition.name, ...(definition.workspace ? [definition.workspace] : [])].map(value => JSON.stringify(value)).join(", ")
}

// A route that imports the Definition runs it with its host identity, also before the host routes load.
function discoveredAgentIdentityDecorator(definition: DiscoveredAgentDefinition): DiscoveredAgentExportDecorator {
  return {
    decorate: value => `vitehubWithDiscoveredAgentName(${value}, ${discoveredAgentIdentityArguments(definition)})`,
    imports: [`import { withDiscoveredAgentName as vitehubWithDiscoveredAgentName } from ${JSON.stringify(agentRuntimeModule("server/internal"))}`],
  }
}

// A folder Agent gets its Workspace only from its `workspace` key. Without the key, it fails when it loads if it owns one.
function checksDeclaredWorkspace(definition: DiscoveredAgentDefinition): boolean {
  return !definition.workspace && isFolderAgentDefinition(definition)
}

// Server transforms check direct imports. The generated catalog also checks hosts that load untransformed Agent files.
function declaredWorkspaceDecorators(definition: DiscoveredAgentDefinition): DiscoveredAgentExportDecorator[] {
  if (!checksDeclaredWorkspace(definition)) return []
  return [{
    decorate: value => `vitehubWithDeclaredAgentWorkspace(${value}, ${JSON.stringify(definition.name)})`,
    imports: [`import { withDeclaredAgentWorkspace as vitehubWithDeclaredAgentWorkspace } from ${JSON.stringify(agentRuntimeModule("server/internal"))}`],
  }]
}

// Direct imports can create derived Agents before any generated registry loads the parent.
function decorateDiscoveredAgentExport(
  code: string,
  parse: (code: string) => unknown,
  decorators: DiscoveredAgentExportDecorator[],
): string | undefined {
  if (!decorators.length) return
  const program = parse(code)
  if (!isPositionedNode(program) || !Array.isArray(program.body)) return
  const imports = decorators.flatMap(decorator => decorator.imports)
  const decorate = (value: string) => decorators.reduce((decorated, decorator) => decorator.decorate(decorated), value)
  for (const statement of program.body) {
    if (!isPositionedNode(statement)) continue
    const declaration = statement.declaration
    if (statement.type === "ExportDefaultDeclaration" && isPositionedNode(declaration)) {
      if (declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration") return
      return [
        ...imports,
        applyCodeReplacements(code, [{ start: declaration.start, end: declaration.end, value: decorate(code.slice(declaration.start, declaration.end)) }]),
      ].join("\n")
    }
    if (statement.type !== "ExportNamedDeclaration" || !Array.isArray(statement.specifiers)) continue
    for (const specifier of statement.specifiers) {
      if (!isPositionedNode(specifier) || !isPositionedNode(specifier.exported) || !isPositionedNode(specifier.local)) continue
      if (specifier.exported.name !== "default" || typeof specifier.local.name !== "string") continue
      if (isPositionedNode(statement.source)) {
        const source = code.slice(statement.source.start, statement.source.end)
        return [
          ...imports,
          `import { ${specifier.local.name} as vitehubReexportedAgent } from ${source}`,
          code,
          `${decorate("vitehubReexportedAgent")}`,
        ].join("\n")
      }
      return [
        ...imports,
        code,
        `${decorate(specifier.local.name)}`,
      ].join("\n")
    }
  }
}

/** The Channel names of each `defineAgent({ channels: ['slack'] })` call in a module. */
function listedChannelNames(program: unknown, code: string, file: string): string[] {
  const agentOptions = discoverAgentOptionsStarts(code, file)
  const names = new Set<string>()
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child)
      return
    }
    if (node === null || typeof node !== "object") return
    const value = node as Record<string, unknown>
    if (isPositionedNode(value) && value.type === "ObjectExpression" && agentOptions.has(value.start)) {
      for (const property of Array.isArray(value.properties) ? value.properties : []) {
        if (!isPositionedNode(property) || property.type !== "Property" || nodePropertyName(property) !== "channels") continue
        if (!isPositionedNode(property.value)) continue
        const list = unwrapTypeScriptExpression(property.value)
        if (list?.type !== "ArrayExpression") continue
        for (const element of Array.isArray(list.elements) ? list.elements : []) {
          const literal = element as { type?: unknown, value?: unknown } | null
          if (literal?.type !== "Literal" || typeof literal.value !== "string") {
            throw agentDiagnostics.AGENT_B0024({ message: `[vitehub] Agent ${file}: list Channels as string literals, such as channels: ['slack']. ViteHub reads them without running the module.` })
          }
          names.add(literal.value)
        }
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== "type" && key !== "start" && key !== "end") visit(child)
    }
  }
  visit(program)
  return [...names]
}

function listedAgentChannelNames(definitions: DiscoveredAgentDefinition[]): Set<string> {
  return new Set(definitions.flatMap((definition) => {
    const code = readFileSync(definition.handler, "utf8")
    return listedChannelNames(scanModule(code, definition.handler).program, code, definition.handler)
  }))
}

/** Non-Nitro outputs route only Channels that a discovered Agent lists. */
function generatedNamedChannelRoutes(channels: readonly StandaloneChannel[] = [], typescript = false): string[] {
  return [
    `const channelWebhookAliases${typescript ? ": Record<string, { agent: string, webhook: string }>" : ""} = ${JSON.stringify(Object.fromEntries(Object.entries(standaloneChannelWebhookAliases(channels)).map(([path, target]) => [normalizeNitroRoute(path).replace(/\/+$/, "") || "/", target])))}`,
    "for (const [path, target] of Object.entries(channelWebhookAliases)) {",
    "  const host = channelHosts[target.webhook]",
    "  if (host) target.agent = host",
    "  else delete channelWebhookAliases[path]",
    "}",
  ]
}

/** Resolves only the Channels listed by real Agent factory calls. */
async function namedAgentChannelModules(
  code: string,
  parse: (code: string) => unknown,
  file: string,
  channels: ReadonlyArray<{ handler: string, name: string }>,
  resolveModule?: NamedChannelModuleResolver,
): Promise<Array<{ handler: string, name: string }>> {
  const names = listedChannelNames(parse(code), code, file)
  return await Promise.all(names.map(async (name) => {
    const channel = channels.find(candidate => candidate.name === name)
    if (!channel) {
      throw agentDiagnostics.AGENT_B0024({ message: `[vitehub] Agent ${file} lists the Channel "${name}", but server/channels has no Channel with that name. Channels: ${channels.map(candidate => candidate.name).join(", ") || "none"}.` })
    }
    await assertNamedChannelImportAcyclic(channel, file, channels, resolveModule)
    return channel
  }))
}

/** Registers listed Channels before the Agent runs, without importing unrelated Channels. */
async function transformNamedAgentChannels(
  code: string,
  parse: (code: string) => unknown,
  file: string,
  channels: ReadonlyArray<{ handler: string, name: string }>,
  resolveModule?: NamedChannelModuleResolver,
): Promise<string | undefined> {
  const modules = await namedAgentChannelModules(code, parse, file, channels, resolveModule)
  if (!modules.length) return
  return [
    `import { registerAgentChannels as vitehubRegisterAgentChannels } from ${JSON.stringify(agentRuntimeModule("server/internal"))}`,
    ...modules.map((channel, index) => `import vitehubChannel${index} from ${JSON.stringify(channel.handler.replace(/\\/g, "/"))}`),
    `vitehubRegisterAgentChannels({ ${modules.map((channel, index) => `[${JSON.stringify(channel.name)}]: vitehubChannel${index}`).join(", ")} })`,
    code,
  ].join("\n")
}

async function prepareRetainedAgentSources(
  sources: { resolve: (path: string) => string },
  definitions: DiscoveredAgentDefinition[],
  channels: ReadonlyArray<{ handler: string, name: string }>,
  resolveModule?: NamedChannelModuleResolver,
): Promise<void> {
  const parse = await parseTypeScript()
  for (const definition of definitions) {
    const handler = sources.resolve(definition.handler)
    if (handler === definition.handler || !existsSync(handler)) continue
    const retainedChannels = channels.map(channel => ({ ...channel, handler: moduleImportSpecifier(handler, sources.resolve(channel.handler)) }))
    const code = await readFile(handler, "utf8")
    await namedAgentChannelModules(code, parse, definition.handler, channels, resolveModule)
    const skills = readColocatedAgentSkills(definition.handler)
    let transformed = decorateDiscoveredAgentExport(code, parse, [
      ...declaredWorkspaceDecorators(definition),
      ...(skills ? [colocatedAgentSkillsDecorator(skills)] : []),
      discoveredAgentIdentityDecorator(definition),
    ]) ?? code
    transformed = await transformNamedAgentChannels(transformed, parse, definition.handler, retainedChannels) ?? transformed
    if (transformed !== code) await writeFile(handler, transformed, "utf8")
  }
}

type NamedChannelModuleResolver = (specifier: string, importer: string) => Promise<string | undefined>

function namedChannelModuleResolver(config: Pick<ResolvedConfig, "createResolver">): NamedChannelModuleResolver {
  let resolveModule: ReturnType<ResolvedConfig["createResolver"]> | undefined
  return async (specifier, importer) => {
    // Resolve application aliases before deciding whether this is a local edge. Installed package imports
    // remain outside the application graph, even when Vite resolves a workspace symlink to its real path.
    resolveModule ??= config.createResolver()
    const local = await resolveModule(specifier, importer, true) ?? specifier
    if (!local.startsWith(".") && !isAbsolute(local)) return
    return await resolveModule(local, importer)
  }
}

/** Follow resolved application modules, independent of the import spelling, before adding an eager edge. */
async function assertNamedChannelImportAcyclic(
  channel: { handler: string, name: string },
  agent: string,
  channels: ReadonlyArray<{ handler: string, name: string }>,
  resolveModule?: NamedChannelModuleResolver,
): Promise<void> {
  if (!isAbsolute(channel.handler)) return
  const visited = new Set<string>()
  const visit = async (file: string): Promise<boolean> => {
    file = file.split(/[?#]/, 1)[0]!
    if (file === agent) return true
    if (visited.has(file) || !isAbsolute(file) || file.includes("/node_modules/") || !/\.(?:c|m)?[jt]sx?$/.test(file) || !existsSync(file)) return false
    visited.add(file)
    const code = readFileSync(file, "utf8")
    const { program } = scanModule(code, file)
    if (!isPositionedNode(program) || !Array.isArray(program.body)) return false
    for (const statement of program.body) {
      if (!isPositionedNode(statement) || !["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(statement.type)) continue
      if (!isPositionedNode(statement.source) || typeof statement.source.value !== "string" || statement.importKind === "type" || statement.exportKind === "type") continue
      if (Array.isArray(statement.specifiers) && statement.specifiers.length && statement.specifiers.every(specifier => isPositionedNode(specifier) && (specifier.importKind === "type" || specifier.exportKind === "type"))) continue
      const dependency = resolveModule
        ? await resolveModule(statement.source.value, file)
        : (statement.source.value.startsWith(".") || isAbsolute(statement.source.value))
            ? resolveModulePath(statement.source.value, { from: pathToFileURL(file), extensions: [".ts", ".mts", ".cts", ".tsx", ".js", ".mjs", ".cjs", ".jsx"], try: true })
            : undefined
      if (dependency && await visit(dependency)) return true
    }
    for (const name of listedChannelNames(program, code, file)) {
      const dependency = channels.find(candidate => candidate.name === name)
      if (dependency && await visit(dependency.handler)) return true
    }
    return false
  }
  if (await visit(channel.handler)) {
    throw agentDiagnostics.AGENT_B0024({ message: `[vitehub] Agent ${agent} lists the Channel "${channel.name}", whose static imports lead back to that Agent. Use a lazy task target, agent: () => import('...'), or leave the Channel unlisted. Named Channels cannot statically import their owning Agent.` })
  }
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

function generatedRuntimeHelpers(): string[] {
  return [
    "type ViteHubGeneratedCloudflare = { context?: unknown, env?: Record<string, unknown> }",
    "type ViteHubGeneratedContext = Parameters<typeof getStandardContext>[0]",
    "",
    // In a ViteHub app, the Request of a route and the event of a Nitro hook carry Standard Context, with the host
    // lifetime and the Cloudflare bindings.
    "export function waitUntilFromContext(context: ViteHubGeneratedContext): AgentWaitUntil | undefined {",
    "  return getStandardContext(context).waitUntil",
    "}",
    "",
    "function cloudflareFromContext(context: ViteHubGeneratedContext): ViteHubGeneratedCloudflare | undefined {",
    "  return getStandardContext(context).runtime?.cloudflare",
    "}",
    "",
    "function runtimeFromContext(context: ViteHubGeneratedContext) {",
    "  if (cloudflareFromContext(context)) return 'cloudflare-agents' as const",
    "  if (typeof process === 'object' && (process.env.VERCEL || process.env.VERCEL_ENV)) return 'vercel' as const",
    "}",
    "",
    // The routes answer every expected failure with a Response. The body has the `{ status, message }` shape of an H3 error.
    "function errorResponse(status: number, message: string): Response {",
    "  return Response.json({ status, message }, { status })",
    "}",
    "",
    // A Fetchable gets no router parameters, so the routes read them from this path. Like the H3 router, it decodes the
    // escapes of characters that need none, such as `%70` for `p`. Other escapes, such as `%20` and `%2F`, stay.
    "function routePathname(request: Request): string {",
    "  const pathname = new URL(request.url).pathname.replace(/%(?:2[146-9A-E]|3[0-9ABD]|4[0-9A-F]|5[0-9ABDF]|6[1-9A-F]|7[0-9ACE])/gi, escape => String.fromCharCode(Number.parseInt(escape.slice(1), 16)))",
    "  return pathname.replace(/\\/+$/, '') || '/'",
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
    `const viteHubChatStateOptions${typescript ? ": Parameters<typeof createLibsqlAgentState>[0]" : ""} = ${JSON.stringify(stateOptions)}`,
    `let viteHubChatState${typescript ? ": ReturnType<typeof createLibsqlAgentState> | undefined" : ""}`,
    "",
    "function chatStateFromLibsql() {",
    "  const runtimeUrl = typeof process === 'object' ? process.env.VITEHUB_AGENT_STATE_URL : undefined",
    "  const url = runtimeUrl || viteHubChatStateOptions.url",
    ...(durableUrlRequired
      ? ["  if (!url) throw vitehubAgentRuntimeError('AGENT_R0893', '[vitehub] Agent state requires a durable VITEHUB_AGENT_STATE_URL for this deployment. Configure agent.providers.state or set the environment variable.')"]
      : []),
    ...(ephemeralHosting
      ? [`  if (url?.startsWith('file:')) throw vitehubAgentRuntimeError('AGENT_R0894', ${JSON.stringify(`[vitehub] Agent state cannot use a file: URL on ${ephemeralHosting} because its filesystem is ephemeral. Configure a durable libSQL URL.`)})`]
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
    `export function resumeWebhookQueues(waitUntil${typescript ? ": AgentWaitUntil | undefined" : ""}, recoverInterruptedBefore${typescript ? "?: number" : ""}) {`,
    "  const runtimeUrl = typeof process === 'object' ? process.env.VITEHUB_AGENT_STATE_URL : undefined",
    "  if (!runtimeUrl && !viteHubChatStateOptions.url) return async () => undefined",
    `  const stops = Object.entries(webhookHandlers).flatMap(([name, handler]) => typeof handler.resume === 'function' ? [handler.resume({ agentIdentity: agentIdentities[name]${runtimeRouteOption}, ${routeCapabilities.requestOption}recoverInterruptedBefore, webhookState: chatStateFromLibsql(), waitUntil })] : [])`,
    "  return async () => await Promise.all(stops.map(stop => stop()))",
    "}",
    "",
  ]
}

/** Startup warm-up of every webhook handler. The readiness route answers 503 until it finishes. */
function generatedWebhookWarmupHelper(routeCapabilities: { requestOption: string }, runtimeRouteOption = ""): string[] {
  return [
    "const webhookWarmup = createAgentWebhookWarmup(Object.fromEntries(Object.entries(webhookHandlers).map(([name, handler]) => [",
    "  name,",
    `  () => handler.warm({ agentIdentity: agentIdentities[name]${runtimeRouteOption}, ${routeCapabilities.requestOption}state: viteHubChatStateResolver, webhookState: viteHubChatStateResolver }),`,
    "])))",
    "/** Warms every webhook handler once. `/api/_vitehub/ready` answers 503 until it finishes. */",
    "export const warmWebhookRoutes = () => webhookWarmup.warm()",
    "export const webhookRoutesReadiness = () => webhookWarmup.readiness()",
    "export const webhookRoutesReadyResponse = (method?: string) => webhookWarmup.response(method)",
    "",
  ]
}

/**
 * Lets the Console read Channel conversations through the same handlers, State, and identities as the webhook routes. A
 * Durable Object State needs the Cloudflare environment of the call, which the Console passes in.
 */
function generatedChannelsConsoleHost(routeCapabilities: { requestOption: string }, runtimeRouteOption = "", cloudflare = false): string[] {
  return [
    "installChannelsConsoleHost({",
    "  agents,",
    "  handlers: webhookHandlers,",
    ...(cloudflare
      ? [
          "  options: (name, env) => {",
          "    const cloudflare = env ? { env } : undefined",
          "    const state = chatStateFromCloudflare(cloudflare)",
          `    return { agentIdentity: agentIdentities[name]${runtimeRouteOption}, ${routeCapabilities.requestOption}cloudflare, state, webhookState: state }`,
          "  },",
        ]
      : [`  options: name => ({ agentIdentity: agentIdentities[name]${runtimeRouteOption}, ${routeCapabilities.requestOption}state: viteHubChatStateResolver, webhookState: viteHubChatStateResolver }),`]),
    "})",
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

function generatedHostedWorkspaceRuntimeSetup(
  definitions: DiscoveredAgentDefinition[],
  typescript = false,
): { imports: string[], setup: string[] } {
  const modules = definitions
    .map((definition, index) => definition.workspace ? `agent${index}` : undefined)
    .filter((module): module is string => Boolean(module))
  if (!modules.length) return { imports: [], setup: [] }
  return {
    imports: [
      `import { installHostedWorkspaceRuntime } from ${JSON.stringify(agentRuntimeModule("internal/workspace/internal/runtime/hosted"))}`,
      `import { installHostedVercelBlobWorkspaceRuntime } from ${JSON.stringify(agentRuntimeModule("internal/workspace/internal/runtime/hosted-vercel-blob"))}`,
    ],
    setup: [
      `function hasHostedWorkspaceStore(module${typescript ? ": AgentRegistryModule" : ""}) {`,
      `  const agent = resolveAgentModule(module)${typescript ? " as WorkspaceAgentDefinition" : ""}`,
      "  const workspace = agent?.__vitehubWorkspaceAgentOptions?.workspace",
      "  const store = workspace && typeof workspace === 'object' ? workspace.store : undefined",
      "  return store && typeof store === 'object' && 'provider' in store && typeof store.provider === 'string' && ['cloudflare-artifacts', 'github'].includes(store.provider)",
      "}",
      "",
      // Same env names as `hasVercelWorkspaceBlobEnv` in @vite-hub/workspace storage/provider.ts.
      `function hasHostedVercelBlobWorkspaceStore(module${typescript ? ": AgentRegistryModule" : ""}) {`,
      `  const agent = resolveAgentModule(module)${typescript ? " as WorkspaceAgentDefinition" : ""}`,
      "  const workspace = agent?.__vitehubWorkspaceAgentOptions?.workspace",
      "  const store = workspace && typeof workspace === 'object' ? workspace.store : undefined",
      "  if (workspace && !store && typeof process === 'object' && (process?.env?.BLOB_STORE_ID || process?.env?.BLOB_READ_WRITE_TOKEN)) return true",
      "  return store && typeof store === 'object' && 'provider' in store && store.provider === 'vercel-blob'",
      "}",
      "",
      `if ([${modules.join(", ")}].some(hasHostedWorkspaceStore)) installHostedWorkspaceRuntime()`,
      `if ([${modules.join(", ")}].some(hasHostedVercelBlobWorkspaceStore)) installHostedVercelBlobWorkspaceRuntime()`,
      "",
    ],
  }
}

/** Load the complete decorated catalog only after the Agent runtime initializes. */
async function writeAgentRuntimeRegistry(
  root: string,
  definitions: DiscoveredAgentDefinition[],
  options: { agentHost?: boolean } = {},
): Promise<void> {
  const seen = new Set<string>()
  for (const definition of definitions) {
    if (seen.has(definition.name)) {
      throw new Error(`Duplicate Agent name discovered: ${definition.name}`)
    }
    seen.add(definition.name)
  }
  const registryPath = join(root, generatedAgentRegistry)
  const catalogPath = join(root, generatedAgentRegistryCatalog)
  await mkdir(dirname(registryPath), { recursive: true })
  // SAFETY: this accumulator is intentionally mutable while generating one lazy registry entry per definition.
  const entries = [] as string[]
  for (let index = 0; index < definitions.length; index++) {
    const definition = definitions[index]
    const definitionCatalogPath = join(dirname(catalogPath), `${basename(catalogPath, extname(catalogPath))}-${index}${extname(catalogPath)}`)
    const catalog = await generateAgentDeploymentCatalog([definition], definitionCatalogPath, {
      ...options,
      channelHandlers: false,
      workspaceRegistry: false,
      resetPublicUrlAgentNames: false,
    })
    await writeFileIfChanged(definitionCatalogPath, [...catalog.imports, "", ...catalog.setup, "", "export { agents }", ""].join("\n"))
    entries.push(`[${JSON.stringify(definition.name)}]: async () => (await import(${JSON.stringify(moduleImportSpecifier(registryPath, definitionCatalogPath))})).agents[${JSON.stringify(definition.name)}]`)
  }
  // Keep the aggregate catalog for development refreshes and existing consumers.
  const aggregateCatalog = await generateAgentDeploymentCatalog(definitions, catalogPath, {
    ...options,
    channelHandlers: false,
    workspaceRegistry: false,
  })
  await writeFileIfChanged(catalogPath, [...aggregateCatalog.imports, "", ...aggregateCatalog.setup, "", "export { agents }", ""].join("\n"))
  // Use a non-cyclic alias reset entry: server internals also import this registry,
  // so their reset re-export can be uninitialized during an internal-first reload.
  await writeFileIfChanged(registryPath, [
    `import { resetPublicUrlAgentNames } from ${JSON.stringify(agentRuntimeModule("server/registry"))}`,
    "resetPublicUrlAgentNames()",
    `export default {${entries.length ? `\n  ${entries.join(",\n  ")}\n` : ""}}`,
    `export const metadata = {${generatedAgentIdentityEntries(definitions)}}`,
    `export async function loadAgentHost() {${options.agentHost ? ' await import("./chat-webhook-route") ' : ""}}`,
    "",
  ].join("\n"))
}

function generatedAgentIdentityEntries(definitions: DiscoveredAgentDefinition[]): string {
  return definitions
    .map(definition => `[${JSON.stringify(definition.name)}]: ${JSON.stringify({ name: definition.name, ...(definition.workspace ? { workspace: definition.workspace } : {}) })}`)
    .join(",\n  ")
}

interface GeneratedAgentDeploymentCatalog {
  imports: string[]
  setup: string[]
}

const retainedColocatedInstructions = Symbol("vitehub.retainedColocatedInstructions")

async function resolveDeploymentColocatedInstructions(definition: DiscoveredAgentDefinition): Promise<string | undefined> {
  // SAFETY: Provider Output preparation attaches this private symbol only to retained Agent Definitions.
  const retainedDefinition = definition as DiscoveredAgentDefinition & {
    [retainedColocatedInstructions]?: string
  }
  if (retainedColocatedInstructions in retainedDefinition) return retainedDefinition[retainedColocatedInstructions]
  return await readColocatedAgentInstructions(definition.handler)
}

async function generateAgentDeploymentCatalog(
  definitions: DiscoveredAgentDefinition[],
  handlerPath: string,
  options: {
    channelHandlers?: boolean
    inspection?: false | string
    typescript?: boolean
    workspaceRegistry?: false
    resetPublicUrlAgentNames?: boolean
    /** Channels from `server/channels`. An inbound one that no Agent lists gets a host Agent for its webhook handler. */
    standaloneChannels?: readonly StandaloneChannel[]
  },
): Promise<GeneratedAgentDeploymentCatalog> {
  const channelHandlers = options.channelHandlers !== false
  const standaloneChannels = channelHandlers ? (options.standaloneChannels ?? []).filter(channel => channel.inbound) : []
  const typescript = options.typescript === true
  if (options.inspection && definitions.length > 1 && !routeUsesParam(options.inspection, "agent")) {
    throw agentDiagnostics.AGENT_B0016({ message: "[vitehub] Multi-Agent inspection routes require an agent route parameter." })
  }
  const entries = await Promise.all(definitions.map(async (definition, index) => {
    const moduleName = `agent${index}`
    const sourceRootDir = resolveWorkspaceSourceRoot(definition.handler)
    const colocatedInstructions = await resolveDeploymentColocatedInstructions(definition)
    const colocatedSkills = readColocatedAgentSkills(definition.handler)
    const agentExpression = `withWorkspaceSourceRoot(agentWithColocatedInstructions(resolveAgentModule(${moduleName}), ${JSON.stringify(colocatedInstructions)}), ${JSON.stringify(sourceRootDir)}, ${JSON.stringify(colocatedInstructions)}, ${JSON.stringify(colocatedSkills)})`
    return {
      agentEntry: `[${JSON.stringify(definition.name)}]: ${agentExpression}`,
      import: `import * as ${moduleName} from ${JSON.stringify(moduleImportSpecifier(handlerPath, definition.handler))}`,
      workspaceEntry: options.workspaceRegistry !== false && definition.workspace
        ? `agentWorkspaceEntry(${JSON.stringify(definition.workspace)}, ${moduleName}, ${JSON.stringify(sourceRootDir)}, ${JSON.stringify(colocatedInstructions)}, ${JSON.stringify(colocatedSkills)})`
        : undefined,
    }
  }))
  const hostedWorkspaceRuntime = generatedHostedWorkspaceRuntimeSetup(definitions, typescript)
  const workspaceEntries = entries.flatMap(entry => entry.workspaceEntry ? [entry.workspaceEntry] : []).join(",\n  ")
  const agentEntries = entries.map(entry => entry.agentEntry).join(",\n  ")
  const registeredAgentWorkspaceEntries = definitions.flatMap(definition => options.workspaceRegistry !== false && definition.workspace
    ? [`markDiscoveredWorkspaceAgentDefinitionRegistered(agents[${JSON.stringify(definition.name)}], ${JSON.stringify({ name: definition.name, workspace: definition.workspace })})`]
    : [])
  const agentIdentityEntries = generatedAgentIdentityEntries(definitions)
  const serverInternalImports = [
    "agentGeneratedRuntimeError as vitehubAgentRuntimeError",
    "inheritAgentLayerOptions",
    "markDiscoveredAgentName",
    "resetPublicUrlAgentNames",
    "workspaceAgentOwnsWorkspaceDefinition",
    "workspaceDefinitionFromOptions",
    options.inspection ? "resolveAgentInspectionMetadata" : undefined,
    channelHandlers || options.inspection ? "createAgentWebhookRequest" : undefined,
    ...(channelHandlers ? ["createChannelChatRouteHandler", "createChannelWebhookRouteHandler", "hasChannelChatRoute", "resolvePublicUrl", "namedChannelHosts"] : []),
    ...(workspaceEntries ? ["markDiscoveredWorkspaceAgentDefinitionRegistered"] : []),
    ...(definitions.some(checksDeclaredWorkspace) ? ["withDeclaredAgentWorkspace"] : []),
  ].filter(Boolean).join(", ")

  return {
    imports: [
      `import { ${typescript ? "type AgentHostIdentity, type AgentInput, type AgentRegistryModule, type AgentWaitUntil, type WorkspaceAgentDefinition, type WorkspaceAgentOptions, " : ""}agentWithColocatedInstructions${standaloneChannels.length ? ", defineAgent" : ""} } from ${JSON.stringify(agentRuntimeModule("index"))}`,
      ...(options.inspection && typescript ? [`import type { ResolvedAgentRuntimeContext } from ${JSON.stringify(agentRuntimeModule("index"))}`] : []),
      `import { ${serverInternalImports} } from ${JSON.stringify(agentRuntimeModule("server/internal"))}`,
      ...(options.workspaceRegistry !== false
        ? [`import { setAgentWorkspaceDefinitions } from ${JSON.stringify(agentRuntimeModule("server/workspace"))}`]
        : []),
      ...hostedWorkspaceRuntime.imports,
      ...entries.map(entry => entry.import),
      ...standaloneChannels.map((channel, index) => `import standaloneChannel${index} from ${JSON.stringify(moduleImportSpecifier(handlerPath, channel.handler))}`),
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
            "  if (!agent) throw vitehubAgentRuntimeError('AGENT_R0895', '[vitehub] Generated Agent module does not export an Agent definition.')",
          ]
        : []),
      `  return agent${typescript ? " as AgentInput" : ""}`,
      "}",
      "",
      ...generatedWorkspaceSourceRootHelper("withWorkspaceSourceRoot", "workspaceDefinitionFromOptions", typescript),
      "",
      ...(workspaceEntries
        ? [
            `function agentWorkspaceEntry(name${typescript ? ": string" : ""}, module${typescript ? ": AgentRegistryModule" : ""}, sourceRootDir${typescript ? ": string" : ""}, colocatedInstructions${typescript ? ": string | undefined" : ""}, colocatedSkills${typescript ? ": ViteHubEncodedColocatedSkills | undefined" : ""}) {`,
            "  const agent = withWorkspaceSourceRoot(agentWithColocatedInstructions(resolveAgentModule(module), colocatedInstructions), sourceRootDir, colocatedInstructions, colocatedSkills)",
            "  if (!workspaceAgentOwnsWorkspaceDefinition(agent)) return",
            "  const workspaceName = markDiscoveredWorkspaceAgentDefinitionRegistered(agent, { name, workspace: name }) || name",
            `  const workspaceDefinition = workspaceDefinitionFromOptions(${typescript ? "(agent as WorkspaceAgentDefinition).__vitehubWorkspaceAgentOptions" : "agent.__vitehubWorkspaceAgentOptions"})`,
            `  return [workspaceName, workspaceDefinition]${typescript ? " as const" : ""}`,
            "}",
            "",
          ]
        : []),
      // Check the exported Agent before the catalog decorates it or registers its Workspace.
      ...definitions.flatMap((definition, index) => checksDeclaredWorkspace(definition)
        ? [`withDeclaredAgentWorkspace(resolveAgentModule(agent${index}), ${JSON.stringify(definition.name)})`]
        : []),
      ...hostedWorkspaceRuntime.setup,
      ...(options.workspaceRegistry !== false
        ? [
            `setAgentWorkspaceDefinitions(Object.fromEntries([${workspaceEntries ? `\n  ${workspaceEntries}\n` : ""}].flatMap(entry => entry ? [entry] : [])))`,
            "",
          ]
        : []),
      `const agents${typescript ? ": Record<string, AgentInput>" : ""} = {${agentEntries ? `\n  ${agentEntries}\n` : ""}}`,
      ...(options.resetPublicUrlAgentNames === false ? [] : ["resetPublicUrlAgentNames()"]),
      ...definitions.map(definition => `markDiscoveredAgentName(agents[${JSON.stringify(definition.name)}], ${discoveredAgentIdentityArguments(definition)})`),
      ...registeredAgentWorkspaceEntries,
      `const agentIdentities${typescript ? ": Record<string, AgentHostIdentity>" : ""} = {${agentIdentityEntries ? `\n  ${agentIdentityEntries}\n` : ""}}`,
      ...(channelHandlers
        ? [
            // The Agent that lists a Channel by name hosts its webhooks. An inbound Channel that no Agent lists gets a host
            // Agent that only serves the Channel's webhooks; its trigger selects the Agent that runs.
            `const channelHosts${typescript ? ": Record<string, string>" : ""} = namedChannelHosts(agents)`,
            `const standaloneChannelAgents${typescript ? ": Record<string, AgentInput>" : ""} = {}`,
            ...standaloneChannels.flatMap((channel, index) => [
              `if (!channelHosts[${JSON.stringify(channel.name)}]) {`,
              `  standaloneChannelAgents[${JSON.stringify(channel.agent)}] = defineAgent({ name: ${JSON.stringify(channel.agent)}, runtime: false, channels: { [${JSON.stringify(channel.name)}]: standaloneChannel${index} }, driver: { run() { throw new Error(${JSON.stringify(`[vitehub] The trigger of Channel "${channel.name}" must select an Agent with a task.`)}) } } })`,
              `  agentIdentities[${JSON.stringify(channel.agent)}] = { name: ${JSON.stringify(channel.agent)} }`,
              "}",
            ]),
            "const chatHandlers = Object.fromEntries(Object.entries(agents).filter(([, agent]) => hasChannelChatRoute(agent)).map(([name, agent]) => [name, createChannelChatRouteHandler(agent)]))",
            "const webhookHandlers = Object.fromEntries(Object.entries({ ...agents, ...standaloneChannelAgents }).map(([name, agent]) => [name, createChannelWebhookRouteHandler(agent)]))",
          ]
        : []),
      "const agentNames = Object.keys(agents)",
      ...(options.inspection
        ? [
            "",
            `async function agentInspectionResponse(name${typescript ? ": string | undefined" : ""}, request${typescript ? ": Request" : ""}, runtime${typescript ? ": Partial<ResolvedAgentRuntimeContext>" : ""} = {})${typescript ? ": Promise<Response>" : ""} {`,
            "  const headers = { 'cache-control': 'private, no-store' }",
            "  if (request.method !== 'GET') return Response.json({ message: 'Method not allowed.', status: 405 }, { headers, status: 405 })",
            "  const selectedName = name || (agentNames.length === 1 ? agentNames[0] : undefined)",
            "  const agent = selectedName ? agents[selectedName] : undefined",
            "  if (!selectedName || !agent) return Response.json({ message: 'Unknown ViteHub agent.', status: 404 }, { headers, status: 404 })",
            "  try {",
            "    const inspection = await resolveAgentInspectionMetadata(agent, {",
            "      input: { abortSignal: request.signal, context: { invoker: { id: 'inspection', kind: 'inspection' } }, messages: [] },",
            "      resolveSources: false,",
            "      runtime: { ...runtime, agentIdentity: agentIdentities[selectedName], request },",
            "    })",
            "    return Response.json({ ...inspection, name: selectedName }, { headers })",
            "  }",
            "  catch {",
            "    return Response.json({ message: 'Agent inspection failed.', status: 500 }, { headers, status: 500 })",
            "  }",
            "}",
          ]
        : []),
    ],
  }
}

async function generateAgentWebhookRouteHandler(
  definitions: DiscoveredAgentDefinition[],
  handlerPath: string,
  options: { webhookAliases?: ResolvedAgentModuleOptions["routes"]["aliases"], preparation?: AgentOptions["preparation"], cloudflareState?: boolean, inspectionRoute?: false | string, libsqlState?: GeneratedLibsqlAgentStateOptions, processDiscordGateway?: boolean, runtime?: "vite", explicitWebhookAliasPaths?: readonly string[], standaloneChannels?: readonly StandaloneChannel[], webhookRoute?: false | string } & AgentGeneratedImportOptions = {},
): Promise<string> {
  const routeCapabilities = generatedAgentRouteCapabilities(options)
  const workflowRuntime = generatedAgentWorkflowRuntime(options)
  const workspaceDependencyRuntime = generatedAgentWorkspaceDependencyRuntime(options)
  const runtimeRouteOption = options.runtime === "vite" ? ", runtime: 'vite'" : ""
  const deploymentCatalog = await generateAgentDeploymentCatalog(definitions, handlerPath, {
    inspection: options.inspectionRoute,
    standaloneChannels: options.standaloneChannels,
    typescript: true,
  })
  const webhookStateOption = options.cloudflareState
    ? "state: chatStateFromCloudflare(cloudflare), webhookState: chatStateFromCloudflare(cloudflare), "
    : options.libsqlState
      ? "state: viteHubChatStateResolver, webhookState: viteHubChatStateResolver, "
      : ""
  const gatewayStateOption = options.libsqlState ? "state: viteHubChatStateResolver, " : ""

  return [
    ...deploymentCatalog.imports,
    `import type { AgentChannelWebhookRouteOptions } from ${JSON.stringify(agentRuntimeModule("server/internal"))}`,
    ...(options.cloudflareState
      ? [
          `import { createCloudflareAgentState, getActiveCloudflareEnv } from ${JSON.stringify(agentRuntimeModule("cloudflare"))}`,
          `import type { ViteHubAgentStateDurableObjectNamespace } from ${JSON.stringify(agentRuntimeModule("cloudflare"))}`,
        ]
      : []),
    ...(options.libsqlState ? [`import { createLibsqlAgentState } from ${JSON.stringify(agentRuntimeModule("state"))}`] : []),
    ...(options.processDiscordGateway ? [`import { createDiscordGatewayRouteHandler } from ${JSON.stringify(agentRuntimeModule("server/internal"))}`] : []),
    ...(options.libsqlState ? [`import { createAgentWebhookWarmup, installChannelsConsoleHost } from ${JSON.stringify(agentRuntimeModule("server/internal"))}`] : []),
    ...(options.cloudflareState && !options.libsqlState ? [`import { installChannelsConsoleHost } from ${JSON.stringify(agentRuntimeModule("server/internal"))}`] : []),
    ...workflowRuntime.imports,
    ...workspaceDependencyRuntime.imports,
    ...routeCapabilities.imports,
    // In a ViteHub app, the Request that Nitro passes to `fetch(request)` carries the Standard Context of the event.
    `import { getStandardContext } from ${JSON.stringify(agentRuntimeModule("server/internal"))}`,
    "",
    ...workflowRuntime.setup,
    ...workspaceDependencyRuntime.setup,
    ...deploymentCatalog.setup,
    // On Node, Nitro passes a srvx Request that builds its native Request lazily, from a body that the handlers have
    // already read when they copy the request. The handlers get a plain Request with the same body stream instead.
    "function toWebhookRequest(request: Request): Request {",
    "  const { headers, method, signal, url } = request",
    "  return createAgentWebhookRequest({ body: request.body ?? undefined, headers, method, signal, url })",
    "}",
    "",
    ...generatedRuntimeHelpers(),
    ...(options.cloudflareState ? generatedCloudflareChatStateHelper() : []),
    ...(options.libsqlState ? generatedLibsqlChatStateHelper(options.libsqlState, true) : []),
    ...(options.libsqlState ? ["/** Agent State for contributed process hosts. */", "export const agentProcessHostState = () => chatStateFromLibsql()"] : []),
    "",
    ...routeCapabilities.setup,
    ...(options.libsqlState ? generatedWebhookQueueResumeHelper(routeCapabilities, true, runtimeRouteOption) : []),
    ...(options.libsqlState ? generatedWebhookWarmupHelper(routeCapabilities, runtimeRouteOption) : []),
    ...(options.libsqlState ? generatedChannelsConsoleHost(routeCapabilities, runtimeRouteOption) : options.cloudflareState ? generatedChannelsConsoleHost(routeCapabilities, runtimeRouteOption, true) : []),
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
          "        if (!response.ok) throw vitehubAgentRuntimeError('AGENT_R0896', `Discord Gateway listener failed with ${response.status}.`)",
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
    // The patterns match the end of the path, so a Nitro base URL before the route does not move them.
    `const chatRoutePattern = new RegExp(${JSON.stringify(routeSuffixRegexSource(defaultAgentChatRoute, ["agent"]))})`,
    `const webhookRoutePattern = new RegExp(${JSON.stringify(routeSuffixRegexSource(options.webhookRoute, ["agent", "webhook"]))});`,
    ...(options.inspectionRoute
      ? [`const inspectionRoutePattern = new RegExp(${JSON.stringify(routeSuffixRegexSource(options.inspectionRoute, ["agent"]))})`]
      : []),
    "",
    `const webhookAliases: Record<string, { agent: string, webhook: string }> = ${JSON.stringify(Object.fromEntries(Object.entries(options.webhookAliases || {}).map(([path, target]) => [normalizeNitroRoute(path).replace(/\/+$/, "") || "/", target])))};`,
    `const configuredWebhookAliasPaths = new Set<string>(${JSON.stringify((options.explicitWebhookAliasPaths || []).map(path => normalizeNitroRoute(path).replace(/\/+$/, "") || "/"))});`,
    // A Channel route targets the Agent that lists the Channel, or its host Agent. A Channel with neither has no route.
    ...(options.standaloneChannels?.length
      ? [
          `const channelRouteNames = new Set<string>(${JSON.stringify(options.standaloneChannels.map(channel => channel.name))})`,
          "for (const [path, target] of Object.entries(webhookAliases)) {",
          "  if (!channelRouteNames.has(target.webhook) || target.agent !== `channel-${target.webhook}`) continue",
          "  const host = channelHosts[target.webhook]",
          "  if (host) webhookAliases[path] = { agent: host, webhook: target.webhook }",
          "  else if (!standaloneChannelAgents[target.agent]) delete webhookAliases[path]",
          "}",
        ]
      : []),
    "type DeclaredWebhookMatcher = { agent: string, matches: (pathname: string) => boolean }",
    // This middleware runs for every request of the app. Declared paths come from the Agent Definitions, so it resolves
    // them once. After that, a request that no Agent declares leaves before the middleware builds a Request or copies headers.
    "let declaredWebhookMatchers: DeclaredWebhookMatcher[] | undefined",
    "async function resolveDeclaredWebhookMatchers(req: Request, url: URL, optionsForAgent: (agent: string) => AgentChannelWebhookRouteOptions) {",
    "  if (declaredWebhookMatchers) return declaredWebhookMatchers",
    // Resolve before acquiring the body stream, so unrelated application routes can still read it.
    "  const request = new Request(url, { headers: req.headers, method: req.method, signal: req.signal })",
    "  const matchers: DeclaredWebhookMatcher[] = []",
    "  for (const [agent, handler] of Object.entries(webhookHandlers)) {",
    "    matchers.push({ agent, matches: await handler.declaredPathMatcher(request, optionsForAgent(agent)) })",
    "  }",
    "  return declaredWebhookMatchers = matchers",
    "}",
    "",
    // The declared webhook middleware runs this for every request. `undefined` passes the request on to the next handler.
    // The middleware passes the URL that H3 already parsed. A request that no Agent declares returns before any await.
    "export function declaredWebhookResponse(request: Request, requestUrl?: URL): Promise<Response | undefined> | undefined {",
    "  const requestPathname = (requestUrl ?? new URL(request.url)).pathname",
    "  const pathname = requestPathname.replace(/\\/+$/, '') || '/'",
    "  const alias = webhookAliases[pathname]",
    "  if (!alias && declaredWebhookMatchers?.every(({ matches }) => !matches(requestPathname))) return",
    "  return declaredWebhookRouteResponse(request, pathname, alias)",
    "}",
    "",
    "async function declaredWebhookRouteResponse(request: Request, pathname: string, alias: { agent: string, webhook: string } | undefined): Promise<Response | undefined> {",
    "  const url = new URL(request.url)",
    "  const cloudflare = cloudflareFromContext(request)",
    `  const optionsForAgent = (agent: string): AgentChannelWebhookRouteOptions => ({ agentIdentity: agentIdentities[agent], ${routeCapabilities.requestOption}cloudflare${runtimeRouteOption}, ${webhookStateOption}waitUntil: waitUntilFromContext(request) })`,
    "  const matchers = await resolveDeclaredWebhookMatchers(request, url, optionsForAgent)",
    "  if (alias) {",
    "    const configuredAlias = configuredWebhookAliasPaths.has(pathname)",
    "    const conflicting = matchers.some(({ agent, matches }) => agent !== alias.agent && matches(url.pathname))",
    "    if (!configuredAlias && conflicting) return errorResponse(409, 'Several Agents declare this webhook path. Configure agent.routes.aliases to select its owner.')",
    "    const handler = webhookHandlers[alias.agent]",
    "    if (!handler) return errorResponse(404, 'Unknown ViteHub agent.')",
    "    return await handler(toWebhookRequest(request), alias.webhook, optionsForAgent(alias.agent))",
    "  }",
    "  const matches = matchers.filter(({ matches }) => matches(url.pathname)).map(({ agent }) => agent)",
    "  if (!matches.length) return",
    "  const scoped = matches.filter(agent => {",
    "    const publicUrl = resolvePublicUrl({ agentName: agent })",
    // TLS may terminate at a proxy while the application receives HTTP for the same public host.
    "    return publicUrl && new URL(publicUrl).host === url.host",
    "  })",
    "  const agent = scoped.length === 1 ? scoped[0] : matches.length === 1 ? matches[0] : undefined",
    "  if (!agent) return errorResponse(409, 'Several Agents declare this webhook path. Configure agent.routes.aliases to select its owner.')",
    "  const handler = webhookHandlers[agent]",
    "  if (!handler) return errorResponse(404, 'Unknown ViteHub agent.')",
    "  return await handler(toWebhookRequest(request), '', optionsForAgent(agent))",
    "}",
    "",
    // One Fetchable serves the chat, webhook, inspection, and alias routes (https://fetchable.org).
    "export default {",
    "  async fetch(request: Request): Promise<Response> {",
    "    const pathname = routePathname(request)",
    "    const alias = webhookAliases[pathname]",
    ...(options.inspectionRoute ? ["    const inspectionMatch = inspectionRoutePattern.exec(pathname)"] : []),
    "    const webhookMatch = webhookRoutePattern.exec(pathname)",
    `    const groups = (${options.inspectionRoute ? "inspectionMatch || " : ""}webhookMatch || chatRoutePattern.exec(pathname))?.groups || {}`,
    "    const isWebhookRoute = Boolean(alias || webhookMatch)",
    "    const agent = alias?.agent || groups.agent || (agentNames.length === 1 ? agentNames[0] : undefined)",
    "    const webhook = alias?.webhook || groups.webhook || ''",
    "    const cloudflare = cloudflareFromContext(request)",
    "    const waitUntil = waitUntilFromContext(request)",
    ...(options.inspectionRoute
      ? [
          "    if (inspectionMatch) {",
          "      const { headers, method, signal, url } = request",
          "      const inspectionRequest = createAgentWebhookRequest({ headers, method, signal, url })",
          `      return await agentInspectionResponse(agent, inspectionRequest, { ${routeCapabilities.requestOption}cloudflare, event: request${runtimeRouteOption || ", runtime: runtimeFromContext(request)"}, waitUntil })`,
          "    }",
        ]
      : []),
    "    if (!agent) return errorResponse(404, 'Unknown ViteHub agent.')",
    "    if (isWebhookRoute) {",
    "      const handler = webhookHandlers[agent]",
    "      if (!handler) return errorResponse(404, 'Unknown ViteHub agent.')",
    `      return await handler(toWebhookRequest(request), webhook, { agentIdentity: agentIdentities[agent], ${routeCapabilities.requestOption}cloudflare${runtimeRouteOption}, ${webhookStateOption}waitUntil })`,
    "    }",
    "    const handler = chatHandlers[agent]",
    "    if (!handler) return errorResponse(404, 'Unknown ViteHub agent.')",
    `    return await handler(toWebhookRequest(request), { agentIdentity: agentIdentities[agent], ${routeCapabilities.requestOption}cloudflare${runtimeRouteOption}, event: request, waitUntil })`,
    "  },",
    "}",
    "",
  ].join("\n")
}

async function generateAgentNetlifyFunctionRouteHandler(
  definitions: DiscoveredAgentDefinition[],
  handlerPath: string,
  options: { discordGatewayRoute?: false | string, inspectionRoute?: false | string, libsqlState?: GeneratedLibsqlAgentStateOptions, runtime?: "vite", webhookRoute?: false | string } & AgentGeneratedImportOptions = {},
): Promise<string> {
  const routeCapabilities = generatedAgentRouteCapabilities(options)
  const workflowRuntime = generatedAgentWorkflowRuntime(options)
  const workspaceDependencyRuntime = generatedAgentWorkspaceDependencyRuntime(options)
  const runtimeRouteOption = options.runtime === "vite" ? ", runtime: 'vite'" : ""
  const deploymentCatalog = await generateAgentDeploymentCatalog(definitions, handlerPath, {
    inspection: options.inspectionRoute,
  })
  const webhookSelector = routeUsesParam(options.webhookRoute, "webhook") ? "netlifyParam(context, 'webhook')" : "''"
  const webhookStateOption = options.libsqlState ? "state: viteHubChatStateResolver, webhookState: viteHubChatStateResolver, " : ""

  return [
    ...deploymentCatalog.imports,
    ...(options.libsqlState ? [`import { createLibsqlAgentState } from ${JSON.stringify(agentRuntimeModule("state"))}`] : []),
    ...(options.libsqlState ? [`import { installChannelsConsoleHost } from ${JSON.stringify(agentRuntimeModule("server/internal"))}`] : []),
    `import { createDiscordGatewayRouteHandler, isViteHubBearerSecretEqual } from ${JSON.stringify(agentRuntimeModule("server/internal"))}`,
    ...workflowRuntime.imports,
    ...workspaceDependencyRuntime.imports,
    ...routeCapabilities.imports,
    "",
    ...workflowRuntime.setup,
    ...workspaceDependencyRuntime.setup,
    "function routePath(route, values) {",
    "  return route",
    "    .replace(/\\[([^\\]]+)\\]/g, (_, key) => encodeURIComponent(Object.hasOwn(values, key) ? values[key] : ''))",
    "    .replace(/(^|\\/):([^/]+)/g, (_, prefix, key) => `${prefix}${encodeURIComponent(Object.hasOwn(values, key) ? values[key] : '')}`)",
    "}",
    "",
    ...deploymentCatalog.setup,
    ...(options.libsqlState ? generatedLibsqlChatStateHelper(options.libsqlState) : []),
    ...generatedNetlifyRuntimeHelpers(),
    ...generatedNamedChannelRoutes(options.standaloneChannels),
    "",
    ...routeCapabilities.setup,
    ...(options.libsqlState ? generatedChannelsConsoleHost(routeCapabilities, runtimeRouteOption) : []),
    ...(options.libsqlState ? generatedWebhookQueueResumeHelper(routeCapabilities, false, runtimeRouteOption) : []),
    "const discordGatewayHandlers = Object.fromEntries(Object.entries(agents).map(([name, agent]) => [name, createDiscordGatewayRouteHandler(agent)]))",
    `const webhookRoute = ${JSON.stringify(generatedWebhookRoute(options.webhookRoute))}`,
    `const defaultDiscordGatewayDurationMs = ${JSON.stringify(9 * 60 * 1000)}`,
    `const chatRoutePattern = new RegExp(${JSON.stringify(routeRegexSource(defaultAgentChatRoute))})`,
    `const webhookRoutePattern = new RegExp(${JSON.stringify(routeRegexSource(options.webhookRoute))});`,
    `const discordGatewayRoutePattern = new RegExp(${JSON.stringify(routeRegexSource(options.discordGatewayRoute))})`,
    ...(options.inspectionRoute
      ? [`const inspectionRoutePattern = new RegExp(${JSON.stringify(routeRegexSource(options.inspectionRoute))})`]
      : []),
    ...(options.libsqlState ? ["let stopWebhookQueues"] : []),
    "",
    "export default async function viteHubAgentNetlifyFunction(request, context) {",
    "  ensureNetlifyHostingEnv()",
    "  const pathname = new URL(request.url).pathname",
    "  const isChatRoute = chatRoutePattern.test(pathname)",
    "  const isDiscordGatewayRoute = discordGatewayRoutePattern.test(pathname)",
    ...(options.inspectionRoute ? ["  const isInspectionRoute = inspectionRoutePattern.test(pathname)"] : []),
    "  const alias = channelWebhookAliases[pathname.replace(/\\/+$/, '') || '/']",
    "  const isWebhookRoute = Boolean(alias) || webhookRoutePattern.test(pathname)",
    "  const agent = alias?.agent || netlifyParam(context, 'agent') || (agentNames.length === 1 ? agentNames[0] : undefined)",
    `  const webhook = alias?.webhook || (${webhookSelector})`,
    ...(options.inspectionRoute
      ? [
          "  const waitUntil = waitUntilFromContext(context)",
          `  if (isInspectionRoute) return await agentInspectionResponse(agent, request, { ${routeCapabilities.requestOption}event: context, waitUntil${runtimeRouteOption} })`,
        ]
      : []),
    "  const handler = agent ? (isDiscordGatewayRoute ? discordGatewayHandlers[agent] : isWebhookRoute ? webhookHandlers[agent] : isChatRoute ? chatHandlers[agent] : undefined) : undefined",
    "  if (!handler) {",
    "    return Response.json({ message: 'Unknown ViteHub agent.', status: 404 }, { status: 404 })",
    "  }",
    ...(options.inspectionRoute ? [] : ["  const waitUntil = waitUntilFromContext(context)"]),
    ...(options.libsqlState ? ["  stopWebhookQueues ||= resumeWebhookQueues(waitUntil)"] : []),
    "  if (isDiscordGatewayRoute) {",
    "    const secret = process.env.VITEHUB_DISCORD_GATEWAY_SECRET",
    "    const localDevelopment = process.env.NODE_ENV === 'development'",
    "    if (!secret && !localDevelopment) {",
    "      return Response.json({ message: 'Discord Gateway route requires VITEHUB_DISCORD_GATEWAY_SECRET.', status: 500 }, { status: 500 })",
    "    }",
    "    if (secret && !isViteHubBearerSecretEqual(request.headers.get('authorization'), secret)) {",
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
  options: { webhookAliases?: ResolvedAgentModuleOptions["routes"]["aliases"], preparation?: AgentOptions["preparation"], cloudflareState?: boolean, inspectionRoute?: false | string, libsqlState?: GeneratedLibsqlAgentStateOptions, processDiscordGateway?: boolean, runtime?: "vite", explicitWebhookAliasPaths?: readonly string[], shutdown?: ResolvedAgentModuleOptions["shutdown"], standaloneChannels?: readonly StandaloneChannel[], webhookRoute?: false | string } & AgentGeneratedImportOptions = {},
  serverDirs = [join(root, "server")],
): Promise<void> {
  const handlerPath = join(root, generatedAgentWebhookRouteHandler)
  const definitions = discoverAgentDefinitions({
    mode: "server-agents",
    scanDirs: serverDirs,
  })
  const standaloneChannels = options.standaloneChannels ?? discoverStandaloneChannels(root, serverDirs)
  const owner = standaloneChannels.find(channel => channel.inbound && definitions.some(definition => definition.name === channel.agent))
  if (owner) throw agentDiagnostics.AGENT_B0024({ message: `[vitehub] Channel ${owner.handler} serves its webhooks as "${owner.agent}", which is also the name of an Agent Definition. Rename the Channel folder or the Agent.` })
  options = { ...options, standaloneChannels, explicitWebhookAliasPaths: Object.keys(options.webhookAliases || {}), webhookAliases: standaloneChannelWebhookAliases(standaloneChannels, options.webhookAliases) }
  await mkdir(dirname(handlerPath), { recursive: true })
  await writeFileIfChanged(handlerPath, await generateAgentWebhookRouteHandler(definitions, handlerPath, options))
  // Nitro middleware passes a request on when it returns nothing, so this one stays an event handler. A Fetchable must
  // return a Response. It imports nothing from H3: it gives the Request to the route module.
  await writeFileIfChanged(join(root, generatedAgentDeclaredWebhookRouteHandler), [
    `import { declaredWebhookResponse } from "./chat-webhook-route"`,
    "",
    "export default (event: { req: Request, url?: URL }) => declaredWebhookResponse(event.req, event.url)",
    "",
  ].join("\n"))
  if (options.preparation) {
    const { route: _route, ...preparation } = options.preparation
    await writeFileIfChanged(join(root, "agent/preparation.ts"), [
      `import "./chat-webhook-route"`,
      `import { createWorkspacePreparation } from ${JSON.stringify(agentRuntimeModule("internal/workspace/runtime"))}`,
      `export const preparation = createWorkspacePreparation(${JSON.stringify(preparation)})`,
    ].join("\n"))
    await writeFileIfChanged(join(root, generatedAgentPreparationPlugin), [
      `import { preparation } from "./preparation"`,
      `import { onShutdown } from ${JSON.stringify(agentRuntimeModule("server/internal"))}`,
      `export default function(nitroApp) {`,
      `  void preparation.start()`,
      `  onShutdown(nitroApp, "agent.preparation", () => preparation.stop())`,
      `}`,
    ].join("\n"))
    await writeFileIfChanged(join(root, generatedAgentPreparationHandler), options.libsqlState
      ? [
          `import { preparation } from "./preparation"`,
          `import { warmWebhookRoutes, webhookRoutesReadiness, webhookRoutesReadyResponse } from "./chat-webhook-route"`,
          `export default {`,
          `  fetch(request: Request) {`,
          `    void warmWebhookRoutes()`,
          `    // The Workspace is not ready to serve deliveries before the webhook handlers are warm.`,
          `    if (!webhookRoutesReadiness().ready) return webhookRoutesReadyResponse(request.method)`,
          `    return preparation.response(request.method)`,
          `  },`,
          `}`,
        ].join("\n")
      : [
          `import { preparation } from "./preparation"`,
          `export default { fetch: (request: Request) => preparation.response(request.method) }`,
        ].join("\n"))
  }
  else {
    for (const file of ["agent/preparation.ts", generatedAgentPreparationPlugin, generatedAgentPreparationHandler]) await rm(join(root, file), { force: true })
  }
  const readyRoutePath = join(root, generatedAgentReadyHandler)
  if (options.libsqlState && !options.preparation) {
    await writeFileIfChanged(readyRoutePath, [
      `import { warmWebhookRoutes, webhookRoutesReadyResponse } from "./chat-webhook-route"`,
      "",
      "/** 200 once every webhook handler is warm, 503 before. Point a readiness probe here. */",
      `export default {`,
      `  fetch(request: Request) {`,
      `    void warmWebhookRoutes()`,
      `    return webhookRoutesReadyResponse(request.method)`,
      `  },`,
      `}`,
      "",
    ].join("\n"))
  }
  else {
    await rm(readyRoutePath, { force: true })
  }
  const gatewayPluginPath = join(root, generatedAgentDiscordGatewayPlugin)
  if (options.processDiscordGateway) {
    await writeFileIfChanged(gatewayPluginPath, [
      `import { startDiscordGateways } from ${JSON.stringify(`./${generatedAgentWebhookRouteHandler.split("/").at(-1)!.replace(/\.ts$/, "")}`)}`,
      `import { onShutdown } from ${JSON.stringify(agentRuntimeModule("server/internal"))}`,
      "",
      "export default function viteHubDiscordGatewayPlugin(nitroApp) {",
      "  const stop = startDiscordGateways()",
      "  let stopping",
      "  function stopDiscordGateways() {",
      "    return stopping ||= stop()",
      "  }",
      "  onShutdown(nitroApp, 'agent.discord-gateway', () => stopDiscordGateways())",
      "}",
      "",
    ].join("\n"))
  }
  else {
    await rm(gatewayPluginPath, { force: true })
  }
  const processHosts = options.libsqlState && !options.cloudflareState ? discoverProcessHostAgentNames(definitions) : []
  const processHostFiles = [generatedAgentProcessHosts, generatedAgentProcessHostsPlugin, generatedAgentProcessHostsDrain, generatedAgentProcessHostsHealth].map(file => join(root, file))
  if (processHosts.length) {
    const routeModule = `./${generatedAgentWebhookRouteHandler.split("/").at(-1)!.replace(/\.ts$/, "")}`
    await writeFileIfChanged(processHostFiles[0]!, [
      `import registry from ${JSON.stringify(agentRegistryId)}`,
      `import { createAgentProcessHosts } from ${JSON.stringify(agentRuntimeModule("process"))}`,
      `import { agentProcessHostState } from ${JSON.stringify(routeModule)}`,
      "",
      `export const host = createAgentProcessHosts({ names: ${JSON.stringify(processHosts)}, registry, state: agentProcessHostState })`,
      "",
    ].join("\n"))
    await writeFileIfChanged(processHostFiles[1]!, [
      `import { host } from "./process-hosts"`,
      `import { onShutdown } from ${JSON.stringify(agentRuntimeModule("server/internal"))}`,
      "",
      "export default function viteHubAgentProcessHostsPlugin(nitroApp) {",
      "  if (import.meta.prerender) return",
      "  // Start after the server starts.",
      "  setTimeout(() => host.start(), 0)",
      "  onShutdown(nitroApp, 'agent.process-hosts', () => host.close())",
      "}",
      "",
    ].join("\n"))
    await writeFileIfChanged(processHostFiles[2]!, `import { host } from "./process-hosts"\n\nexport default { fetch: () => Response.json({ status: host.status() }) }\n`)
    await writeFileIfChanged(processHostFiles[3]!, `import { host } from "./process-hosts"\n\nexport default { fetch: async () => Response.json(await host.health()) }\n`)
  }
  else {
    await Promise.all(processHostFiles.map(file => rm(file, { force: true })))
  }
  const queuePluginPath = join(root, generatedAgentWebhookQueuePlugin)
  if (options.libsqlState) {
    // A persistent server resumes queued deliveries at startup. Ephemeral hosts resume on
    // the first webhook request, so its waitUntil keeps the function alive during the drain.
    const persistent = !options.libsqlState.ephemeralHosting
    // A persistent server also drains inline Chat invocations when it stops.
    const shutdown = persistent && options.shutdown !== false ? options.shutdown ?? {} : undefined
    const internalImport = JSON.stringify(agentRuntimeModule("server/internal"))
    await writeFileIfChanged(queuePluginPath, [
      `import { resumeWebhookQueues, warmWebhookRoutes${persistent ? "" : ", waitUntilFromContext"} } from ${JSON.stringify(`./${generatedAgentWebhookRouteHandler.split("/").at(-1)!.replace(/\.ts$/, "")}`)}`,
      `import { ${shutdown ? "drainInlineChatInvocations, " : ""}${persistent ? "onAgentRoutesLoad, registerChannelTaskQueueStarter, " : ""}onShutdown, webhookQueueShutdown } from ${internalImport}`,
      "",
      "export default function viteHubWebhookQueuePlugin(nitroApp) {",
      "  let stop",
      "  let stopping",
      "  let closed = false",
      "  let waitUntil",
      "  let startTimer",
      ...(persistent ? ["  let unregisterTaskQueueStarter"] : []),
      "  function shutdownWebhookQueues() {",
      "    closed = true",
      "    clearTimeout(startTimer)",
      ...(persistent ? ["    unregisterTaskQueueStarter?.()"] : []),
      "    if (!stopping) stopping = stop?.()",
      "    if (stopping) waitUntil?.(stopping)",
      "    return stopping",
      "  }",
      "  function startWebhookQueues(recoverInterruptedBefore) {",
      "    if (closed || stop || stopping) return",
      "    stop = resumeWebhookQueues(waitUntil, recoverInterruptedBefore)",
      "  }",
      ...(persistent
        ? [
            "  const startedAt = performance.timeOrigin",
            "  // Start one second after the server starts, so the Agent routes do not compile while the server answers its",
            "  // first requests, or at once when a request loads them. Invocations that started before this process are",
            "  // interrupted unless a queued delivery runs them again or a live run in another process holds their claim.",
            "  // The warm-up builds registrations, secrets, and State before the first delivery needs them.",
            "  // /api/_vitehub/ready starts it at once and answers 503 until it finishes.",
            "  function startNow() {",
            "    clearTimeout(startTimer)",
            "    if (closed || stop) return",
            "    void warmWebhookRoutes()",
            "    startWebhookQueues(startedAt)",
            "  }",
            "  if (!import.meta.prerender) {",
            "    unregisterTaskQueueStarter = registerChannelTaskQueueStarter(startNow)",
            `    startTimer = setTimeout(startNow, ${JSON.stringify(webhookQueueStartDelayMs)})`,
            "    onAgentRoutesLoad(startNow)",
            "  }",
            ...(shutdown
              ? [
                  "  // Inline Chat invocations post a restart notice when the drain interrupts them, and the",
                  "  // next process retries them once. The queue replays the deliveries that it aborts.",
                  "  if (!import.meta.dev && !import.meta.prerender) {",
                  ...(shutdown.drainMs !== undefined
                    ? [`    if (typeof process === 'object' && process?.env && !process.env.VITEHUB_SHUTDOWN_DRAIN_MS) process.env.VITEHUB_SHUTDOWN_DRAIN_MS = ${JSON.stringify(String(shutdown.drainMs))}`]
                    : []),
                  "    onShutdown(nitroApp, 'agent.chat', ({ timeoutMs }) => drainInlineChatInvocations({ timeoutMs }))",
                  "  }",
                ]
              : []),
          ]
        : [
            `  const webhookRoutePattern = new RegExp(${JSON.stringify(routeRegexSource(options.webhookRoute))});`,
            `  const webhookAliases = ${JSON.stringify(Object.fromEntries(Object.entries(options.webhookAliases || {}).map(([path, target]) => [normalizeNitroRoute(path).replace(/\/+$/, '') || '/', target])))};`,
            "  nitroApp.hooks.hook('request', event => {",
            "    const pathname = new URL(event?.path || event?.node?.req?.url || event?.node?.req?.originalUrl || '/', 'http://vitehub.local').pathname.replace(/\\/+$/, '') || '/';",
            "    if (stop || !(webhookAliases[pathname] || webhookRoutePattern.test(pathname))) return;",
            "    waitUntil ||= waitUntilFromContext(event)",
            "    void warmWebhookRoutes()",
            "    startWebhookQueues()",
            "  })",
          ]),
      "  onShutdown(nitroApp, 'agent.webhook-queues', async () => {",
      "    await shutdownWebhookQueues()",
      "    await webhookQueueShutdown()",
      "  })",
      "}",
      "",
    ].join("\n"))
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
  const routeCapabilities = generatedAgentRouteCapabilities(options)
  const workflowRuntime = generatedAgentWorkflowRuntime(options)
  const workspaceDependencyRuntime = generatedAgentWorkspaceDependencyRuntime(options)
  const runtimeRouteOption = options.runtime === "vite" ? ", runtime: 'vite'" : ""
  const deploymentCatalog = await generateAgentDeploymentCatalog(definitions, handlerPath, {
    channelHandlers: false,
    typescript: true,
  })

  return [
    ...deploymentCatalog.imports,
    `import { createDiscordGatewayRouteHandler } from ${JSON.stringify(agentRuntimeModule("server"))}`,
    `import { getStandardContext, isViteHubBearerSecretEqual } from ${JSON.stringify(agentRuntimeModule("server/internal"))}`,
    ...workflowRuntime.imports,
    ...workspaceDependencyRuntime.imports,
    ...routeCapabilities.imports,
    "",
    ...workflowRuntime.setup,
    ...workspaceDependencyRuntime.setup,
    ...deploymentCatalog.setup,
    ...generatedRuntimeHelpers(),
    "",
    "function runtimeEnvValue(cloudflare, key) {",
    "  return cloudflare?.env?.[key] ?? (typeof process === 'object' ? process.env[key] : undefined)",
    "}",
    "",
    "function routePath(route, values) {",
    "  return route",
    "    .replace(/\\[([^\\]]+)\\]/g, (_, key) => encodeURIComponent(Object.hasOwn(values, key) ? values[key] : ''))",
    "    .replace(/(^|\\/):([^/]+)/g, (_, prefix, key) => `${prefix}${encodeURIComponent(Object.hasOwn(values, key) ? values[key] : '')}`)",
    "}",
    "",
    ...routeCapabilities.setup,
    `const webhookRoute = ${JSON.stringify(generatedWebhookRoute(options.webhookRoute))}`,
    `const defaultDurationMs = ${JSON.stringify(9 * 60 * 1000)}`,
    "const handlers = Object.fromEntries(Object.entries(agents).map(([name, agent]) => [name, createDiscordGatewayRouteHandler(agent)]))",
    // The pattern matches the end of the path, so a Nitro base URL before the route does not move it.
    `const discordGatewayRoutePattern = new RegExp(${JSON.stringify(routeSuffixRegexSource(options.discordGatewayRoute, ["agent"]))})`,
    "",
    "export default {",
    "  async fetch(request: Request): Promise<Response> {",
    "    const cloudflare = cloudflareFromContext(request)",
    "    const secret = runtimeEnvValue(cloudflare, 'VITEHUB_DISCORD_GATEWAY_SECRET')",
    "    const localDevelopment = typeof process === 'object' && process.env.NODE_ENV === 'development'",
    "    if (!secret && !localDevelopment) return errorResponse(500, 'Discord Gateway route requires VITEHUB_DISCORD_GATEWAY_SECRET.')",
    "    if (secret && !isViteHubBearerSecretEqual(request.headers.get('authorization'), secret)) return errorResponse(401, 'Unauthorized')",
    "    const requestUrl = new URL(request.url)",
    "    const agent = discordGatewayRoutePattern.exec(routePathname(request))?.groups?.agent || (agentNames.length === 1 ? agentNames[0] : undefined)",
    "    const handler = agent ? handlers[agent] : undefined",
    "    if (!agent || !handler) return errorResponse(404, 'Unknown ViteHub agent.')",
    "    const durationMs = Number(runtimeEnvValue(cloudflare, 'VITEHUB_DISCORD_GATEWAY_DURATION_MS') || '') || defaultDurationMs",
    "    const webhookUrl = runtimeEnvValue(cloudflare, 'VITEHUB_DISCORD_GATEWAY_WEBHOOK_URL') || (webhookRoute ? (webhook) => `${requestUrl.origin}${routePath(webhookRoute, { agent, webhook })}` : undefined)",
    "    if (!webhookUrl) return errorResponse(500, 'Discord Gateway route requires an Agent webhook route.')",
    `    return await handler(new Request(requestUrl, { method: request.method, headers: request.headers }), { agentIdentity: agentIdentities[agent], ${routeCapabilities.requestOption}cloudflare, durationMs${runtimeRouteOption}, waitUntil: waitUntilFromContext(request), webhookUrl })`,
    "  },",
    "}",
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
  await writeFileIfChanged(handlerPath, await generateAgentDiscordGatewayRouteHandler(definitions, handlerPath, options))
}

async function generateAgentDenoServer(
  definitions: DiscoveredAgentDefinition[],
  handlerPath: string,
  options: { inspectionRoute?: false | string, libsqlState?: GeneratedLibsqlAgentStateOptions, webhookRoute?: false | string } & AgentGeneratedImportOptions = {},
): Promise<string> {
  const routeCapabilities = generatedAgentRouteCapabilities(options)
  const workflowRuntime = generatedAgentWorkflowRuntime(options)
  const workspaceDependencyRuntime = generatedAgentWorkspaceDependencyRuntime(options)
  const deploymentCatalog = await generateAgentDeploymentCatalog(definitions, handlerPath, {
    inspection: options.inspectionRoute,
    typescript: true,
  })

  return [
    ...deploymentCatalog.imports,
    ...(options.libsqlState ? [`import { createLibsqlAgentState } from ${JSON.stringify(agentRuntimeModule("state"))}`] : []),
    ...(options.libsqlState ? [`import { installChannelsConsoleHost } from ${JSON.stringify(agentRuntimeModule("server/internal"))}`] : []),
    ...workflowRuntime.imports,
    ...workspaceDependencyRuntime.imports,
    ...routeCapabilities.imports,
    "",
    ...workflowRuntime.setup,
    ...workspaceDependencyRuntime.setup,
    ...deploymentCatalog.setup,
    ...(options.libsqlState ? generatedLibsqlChatStateHelper(options.libsqlState, true) : []),
    ...generatedNamedChannelRoutes(options.standaloneChannels, true),
    ...routeCapabilities.setup,
    ...(options.libsqlState ? generatedChannelsConsoleHost(routeCapabilities, ", runtime: 'deno'") : []),
    ...(options.libsqlState ? generatedWebhookQueueResumeHelper(routeCapabilities, true) : []),
    `await import(${JSON.stringify(options.denoCronImport ?? "../schedule/deno-cron.mjs")}).catch((error) => {`,
    "  if (error instanceof TypeError && String(error.message).includes('deno-cron.mjs')) return",
    "  throw error",
    "})",
    "",
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
    "      if (!Number.isInteger(port) || port < 0 || port > 65535) throw vitehubAgentRuntimeError('AGENT_R0897', '[vitehub] Deno Provider Output expected --port to be a valid TCP port.')",
    "      options.port = port",
    "      index = portArg.index",
    "    }",
    "  }",
    "  return Object.keys(options).length ? options : undefined",
    "}",
    "",
    `const chatRoutePattern = new RegExp(${JSON.stringify(routeRegexSource(defaultAgentChatRoute, ["agent"]))})`,
    `const webhookRoutePattern = new RegExp(${JSON.stringify(routeRegexSource(options.webhookRoute, ["agent", "webhook"]))})`,
    ...(options.inspectionRoute
      ? [`const inspectionRoutePattern = new RegExp(${JSON.stringify(routeRegexSource(options.inspectionRoute, ["agent"]))})`]
      : []),
    "",
    "async function handleRequest(request) {",
    "  const pathname = new URL(request.url).pathname",
    "  const chatMatch = chatRoutePattern.exec(pathname)",
    ...(options.inspectionRoute ? ["  const inspectionMatch = inspectionRoutePattern.exec(pathname)"] : []),
    "  const webhookMatch = webhookRoutePattern.exec(pathname)",
    ...(options.inspectionRoute ? ["  const isInspectionRoute = Boolean(inspectionMatch)"] : []),
    "  const alias = channelWebhookAliases[pathname.replace(/\\/+$/, '') || '/']",
    "  const isWebhookRoute = Boolean(alias) || Boolean(webhookMatch)",
    `  const groups = (${options.inspectionRoute ? "inspectionMatch || " : ""}webhookMatch || chatMatch)?.groups || {}`,
    "  const agent = alias?.agent || (groups.agent ? decodeRouteParam(groups.agent) : (agentNames.length === 1 ? agentNames[0] : undefined))",
    "  const webhook = alias?.webhook || decodeRouteParam(groups.webhook)",
    ...(options.inspectionRoute
      ? [
          `  if (isInspectionRoute) return await agentInspectionResponse(agent, request, { ${routeCapabilities.requestOption}runtime: 'deno' })`,
        ]
      : []),
    "  const handler = agent ? (isWebhookRoute ? webhookHandlers[agent] : chatHandlers[agent]) : undefined",
    "  if (!handler || (!chatMatch && !isWebhookRoute)) return jsonError(404, 'Unknown ViteHub agent route.')",
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
  options: { inspectionRoute?: false | string, libsqlState?: GeneratedLibsqlAgentStateOptions, webhookRoute?: false | string } & AgentGeneratedImportOptions = {},
  serverDirs = [join(root, "server")],
  registryDefinitions?: DiscoveredAgentDefinition[],
  resolveModule?: NamedChannelModuleResolver,
): Promise<void> {
  const handlerPath = join(root, generatedAgentDenoServer)
  let definitions = discoverAgentDefinitions({
    mode: "server-agents",
    scanDirs: serverDirs,
  })
  const channels = discoverAgentChannelModules(serverDirs)
  const sourceDefinitions = registryDefinitions ?? definitions
  const names = listedAgentChannelNames(sourceDefinitions)
  if (names.size) {
    const retainedSources = await retainProviderOutputSources({
      artifactDir: join(root, "agent/deno-sources"),
      paths: [...sourceDefinitions.map(definition => definition.handler), ...channels.filter(channel => names.has(channel.name)).map(channel => channel.handler)],
      roots: [options.sourceRootDir ?? resolve(root, "..")],
    })
    await prepareRetainedAgentSources(retainedSources, sourceDefinitions, channels, resolveModule)
    definitions = definitions.map(definition => ({ ...definition, handler: retainedSources.resolve(definition.handler) }))
    await writeAgentRuntimeRegistry(root, sourceDefinitions.map(definition => ({ ...definition, handler: retainedSources.resolve(definition.handler) })))
  }
  await mkdir(dirname(handlerPath), { recursive: true })
  await writeFileIfChanged(handlerPath, await generateAgentDenoServer(definitions, handlerPath, options))
}

async function writeAgentNetlifyFunctionRouteHandler(
  root: string,
  options: { discordGatewayRoute?: false | string, inspectionRoute?: false | string, libsqlState?: GeneratedLibsqlAgentStateOptions, runtime?: "vite", webhookRoute?: false | string } & AgentGeneratedImportOptions = {},
  serverDirs = [join(root, "server")],
  retainedDefinitions?: DiscoveredAgentDefinition[],
): Promise<string> {
  const handlerPath = join(root, generatedAgentNetlifyFunction)
  const definitions = retainedDefinitions ?? discoverAgentDefinitions({
    mode: "server-agents",
    scanDirs: serverDirs,
  })
  await mkdir(dirname(handlerPath), { recursive: true })
  await writeFileIfChanged(handlerPath, await generateAgentNetlifyFunctionRouteHandler(definitions, handlerPath, options))
  return handlerPath
}

function createNetlifyAgentFunctionConfig(options: { channelPaths?: string[], discordGatewayRoute?: false | string, includedFiles?: string[], inspectionRoute?: false | string, webhookRoute?: false | string }): object {
  const paths = [
    normalizeNitroRoute(defaultAgentChatRoute),
    options.webhookRoute ? normalizeNitroRoute(options.webhookRoute) : undefined,
    options.discordGatewayRoute ? normalizeNitroRoute(options.discordGatewayRoute) : undefined,
    options.inspectionRoute ? normalizeNitroRoute(options.inspectionRoute) : undefined,
    ...(options.channelPaths ?? []),
  ].filter((path): path is string => Boolean(path))

  const config: { includedFiles?: string[], name: string, nodeBundler: string, path: string | string[] | undefined } = {
    path: paths.length === 1 ? paths[0] : paths,
    name: netlifyAgentFunctionName,
    nodeBundler: "esbuild",
  }
  if (options.includedFiles?.length) config.includedFiles = options.includedFiles
  return config
}

async function writeNetlifyAgentProviderOutput(
  config: ResolvedConfig,
  options: ResolvedAgentModuleOptions,
  generatedOptions: AgentGeneratedImportOptions & { libsqlState?: GeneratedLibsqlAgentStateOptions, runtime?: "vite", sourceRootDir?: string } = {},
  serverDirs?: string[],
  write: ProviderDeploymentOutputWriter = writeProviderDeploymentOutputs,
  retainedDefinitions?: DiscoveredAgentDefinition[],
  retainedSourcesDir?: string,
): Promise<void> {
  const netlifySourcesDir = resolve(createDefaultNetlifyOutputRoot(config.root), "agent", "sources")
  const netlifyFunctionsDir = resolve(createDefaultNetlifyOutputRoot(config.root), "functions")
  const includedSourcesDir = relative(netlifyFunctionsDir, netlifySourcesDir).replace(/\\/g, "/")
  const handlerPath = await writeAgentNetlifyFunctionRouteHandler(resolveViteHubGeneratedRoot(config), {
    ...generatedOptions,
    discordGatewayRoute: options.routes.discordGateway,
    inspectionRoute: options.routes.inspection,
    libsqlState: generatedOptions.libsqlState ?? resolveLibsqlAgentState(options, config),
    webhookRoute: options.routes.webhooks,
  }, serverDirs ?? [join(config.root, "server")], retainedDefinitions)
  await write({
    afterWrite: retainedSourcesDir
      ? async signal => await publishNetlifyAgentProviderSources(config, retainedSourcesDir, generatedOptions.sourceRootDir ?? config.root, signal)
      : undefined,
    clientOutDir: config.build?.outDir ?? "dist",
    netlify: {
      functions: [{
        bundleEntry: handlerPath,
        bundleOptions: {
          define: resolveViteHubBundleDefines(config),
          alias: {
            ...resolveStringAliases(config),
            ...generatedOptions.providerImportAliases,
          },
          external: resolveNetlifyAgentBundleExternals(generatedOptions),
          format: "esm",
          platform: "node",
          workingDir: generatedOptions.sourceRootDir,
        },
        config: createNetlifyAgentFunctionConfig({
          channelPaths: generatedOptions.standaloneChannels?.flatMap(channel => channel.paths.map(normalizeNitroRoute)),
          discordGatewayRoute: options.routes.discordGateway,
          includedFiles: retainedSourcesDir ? [`${includedSourcesDir}/**`] : undefined,
          inspectionRoute: options.routes.inspection,
          webhookRoute: options.routes.webhooks,
        }),
        functionName: netlifyAgentFunctionName,
      }],
    },
    rootDir: config.root,
    sourceRootDir: generatedOptions.sourceRootDir,
  })
}

async function publishNetlifyAgentProviderSources(config: ResolvedConfig, retainedSourcesDir: string, retainedAgentRoot: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const generatedAgentDir = resolve(resolveViteHubGeneratedRoot(config), "agent")
  const publishedSourcesDir = resolve(generatedAgentDir, "sources")
  const netlifySourcesDir = resolve(createDefaultNetlifyOutputRoot(config.root), "agent", "sources")
  const deployedSourcesDir = relative(config.root, netlifySourcesDir).replace(/\\/g, "/")
  const nextAgentDir = `${generatedAgentDir}.${randomUUID()}.next`
  const previousAgentDir = `${generatedAgentDir}.${randomUUID()}.previous`
  const nextNetlifySourcesDir = `${netlifySourcesDir}.${randomUUID()}.next`
  const previousNetlifySourcesDir = `${netlifySourcesDir}.${randomUUID()}.previous`
  const netlifyFunction = resolve(createDefaultNetlifyOutputRoot(config.root), "functions", `${netlifyAgentFunctionName}.mjs`)
  let installedNext = false
  let installedNextNetlifySources = false
  let movedPrevious = false
  let movedPreviousNetlifySources = false
  let netlifyFunctionContents: string | undefined
  let publicationSettled = false
  try {
    await cp(generatedAgentDir, nextAgentDir, { recursive: true })
    await rm(resolve(nextAgentDir, "sources"), { force: true, recursive: true })
    const nextSourcesDir = resolve(nextAgentDir, "sources")
    await cp(retainedSourcesDir, nextSourcesDir, { recursive: true })
    await rebasePublishedProviderSourceLinks(nextSourcesDir, retainedSourcesDir, publishedSourcesDir)
    await mkdir(dirname(nextNetlifySourcesDir), { recursive: true })
    await cp(retainedSourcesDir, nextNetlifySourcesDir, { recursive: true })
    await rebasePublishedProviderSourceLinks(nextNetlifySourcesDir, retainedSourcesDir, netlifySourcesDir)
    const retainedCatalog = join(retainedAgentRoot, ".vitehub", generatedAgentRegistryCatalog)
    if (existsSync(retainedCatalog)) {
      const catalogContents = await readFile(retainedCatalog, "utf8")
      const catalogRelativePath = relative(retainedSourcesDir, retainedCatalog)
      await Promise.all([
        writeFile(join(nextSourcesDir, catalogRelativePath), rewriteRetainedProviderSourcePaths(catalogContents, retainedSourcesDir, publishedSourcesDir), "utf8"),
        writeFile(join(nextNetlifySourcesDir, catalogRelativePath), rewriteRetainedProviderSourcePaths(catalogContents, retainedSourcesDir, deployedSourcesDir), "utf8"),
      ])
    }
    const nextHandler = resolve(nextAgentDir, "netlify-function.mjs")
    const publishedHandler = resolve(generatedAgentDir, "netlify-function.mjs")
    const nextHandlerContents = await readFile(nextHandler, "utf8")
    await writeFile(nextHandler, rewriteRetainedProviderSourcePaths(nextHandlerContents, retainedSourcesDir, publishedSourcesDir, {
      published: publishedHandler,
      retained: publishedHandler,
    }), "utf8")
    signal?.throwIfAborted()
    await rename(generatedAgentDir, previousAgentDir)
    movedPrevious = true
    await rename(nextAgentDir, generatedAgentDir)
    installedNext = true
    if (existsSync(netlifySourcesDir)) {
      await rename(netlifySourcesDir, previousNetlifySourcesDir)
      movedPreviousNetlifySources = true
    }
    await rename(nextNetlifySourcesDir, netlifySourcesDir)
    installedNextNetlifySources = true
    netlifyFunctionContents = await readFile(netlifyFunction, "utf8")
    await writeFile(netlifyFunction, rewriteRetainedProviderSourcePaths(netlifyFunctionContents, retainedSourcesDir, deployedSourcesDir, {
      published: netlifyFunction,
      retained: netlifyFunction,
    }), "utf8")
    signal?.throwIfAborted()
    publicationSettled = true
    await Promise.all([
      removeProviderOutputArtifactDir(previousAgentDir).catch(() => undefined),
      removeProviderOutputArtifactDir(previousNetlifySourcesDir).catch(() => undefined),
    ])
  }
  catch (error) {
    if (publicationSettled) throw error
    await rm(nextAgentDir, { force: true, recursive: true })
    await rm(nextNetlifySourcesDir, { force: true, recursive: true })
    if (installedNext) await rm(generatedAgentDir, { force: true, recursive: true })
    if (movedPrevious) await rename(previousAgentDir, generatedAgentDir)
    if (installedNextNetlifySources) await rm(netlifySourcesDir, { force: true, recursive: true })
    if (movedPreviousNetlifySources) await rename(previousNetlifySourcesDir, netlifySourcesDir)
    if (netlifyFunctionContents !== undefined) await writeFile(netlifyFunction, netlifyFunctionContents, "utf8")
    throw error
  }
}

async function cleanupNetlifyAgentProviderOutput(
  config: ResolvedConfig,
  write: ProviderDeploymentOutputWriter = writeProviderDeploymentOutputs,
): Promise<void> {
  await write({
    afterWrite: async () => await removeProviderOutputArtifactDir(resolve(createDefaultNetlifyOutputRoot(config.root), "agent")),
    clientOutDir: config.build?.outDir ?? "dist",
    cleanup: {
      netlify: {
        functionNames: [netlifyAgentFunctionName],
      },
    },
    rootDir: config.root,
  })
}

// Multiple dev servers share process.env. Restore its input only after every participating plugin releases it.
const channelSimulationOwners = new Set<object>()
let channelSimulationPreviousValue: string | undefined

export function hubAgent(options?: AgentOptions): AgentVitePlugin {
  const channelSimulationOwner = {}
  function setChannelSimulation(enabled: boolean, config?: ResolvedConfig): void {
    const env = globalThis.process.env
    if (enabled) {
      if (channelSimulationOwners.has(channelSimulationOwner)) return
      if (channelSimulationOwners.size === 0) {
        channelSimulationPreviousValue = env[channelSimulationEnv]
        if (env[channelSimulationEnv] !== "simulate") {
          env[channelSimulationEnv] = "simulate"
          config?.logger.info("[vitehub] Simulated Channels: Slack, Discord, Teams, and Telegram run on a simulated chat. Open /api/_vitehub/agents/<agent>/webhooks/<channel> in a browser to chat, or POST an AI SDK chat request to it.")
        }
      }
      channelSimulationOwners.add(channelSimulationOwner)
    }
    else if (channelSimulationOwners.delete(channelSimulationOwner) && channelSimulationOwners.size === 0) {
      if (env[channelSimulationEnv] !== "simulate") return
      if (channelSimulationPreviousValue === undefined) delete env[channelSimulationEnv]
      else env[channelSimulationEnv] = channelSimulationPreviousValue
    }
  }
  const frameworkOptions = getInternalAgentOptions(options)
  const agent: AgentOptions | undefined = options
  let runtimeCapabilities: GeneratedAgentRuntimeCapability[] = []
  let standaloneRuntimeCapabilities: GeneratedAgentRuntimeCapability[] = []
  let installsCloudflareState = false
  let providerOutput: ProviderOutputCatalog | undefined
  const providerOutputGenerations = createProviderDeploymentOutputGenerationState()
  const providerOutputEnvironment = createProviderOutputEnvironmentOwner("@vite-hub/agent/vite")
  const buildConfigs = new WeakMap<object, {
    agent: AgentOptions | false | undefined
    config: ResolvedConfig
    providerOutput: ProviderOutputCatalog | undefined
    serverDirs: string[] | undefined
    runtimeCapabilities: GeneratedAgentRuntimeCapability[]
  }>()
  const scheduledBuildConfigsByRoot = new Map<string, ResolvedConfig[]>()
  const rejectedBuilds = new WeakSet<object>()
  const fallbackEnvironment = {}
  const buildEnvironment = (context: { environment?: object } | undefined): object =>
    context?.environment ?? context ?? fallbackEnvironment
  let resolved: ResolvedConfig | undefined
  // The Agent state store that the server uses, when the app has hosted Agents.
  let stateDurability: AgentStateDurabilityInput | undefined
  let closeDiscoveryWatcher: (() => Promise<void>) | undefined
  let serverDirs: string[] | undefined

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
    // CLI stage servers resolve a serve config for discovery without starting an interactive dev server.
    // SAFETY: Vite preserves this optional discovery flag from the inline config.
    const cliStageServer = (config as ResolvedConfig & { vitehubCliDiscovery?: unknown }).vitehubCliDiscovery === true
    setChannelSimulation(Boolean(normalized && agent && agent.channels?.simulate && config.command === "serve" && !cliStageServer), config)
    if (normalized) validateInspectionRoute(normalized.routes)
    const processDiscordGateway = Boolean(getInternalAgentOptions(agent)?.processDiscordGateway)
    const generatedRoot = resolveViteHubGeneratedRoot(config)
    const definitionServerDirs = serverDirs ?? [join(config.root, "server")]
    const standaloneChannels = normalized ? discoverStandaloneChannels(viteHubProjectRoot(config), definitionServerDirs) : []
    const hasHostedAgents = hasHostedAgentDefinitions(config.root, definitionServerDirs, standaloneChannels)
    const registryDefinitions = normalized
      ? [
          ...discoverAgentDefinitions({ mode: "vite-suffix", rootDir: config.root }),
          ...discoverAgentDefinitions({ mode: "server-agents", scanDirs: definitionServerDirs }),
        ]
      : []
    await writeAgentRuntimeRegistry(generatedRoot, registryDefinitions, {
      agentHost: Boolean(normalized && hasHostedAgents && normalized.runtime !== "deno"),
    })
    if (normalized && config.command === "serve") {
      const registryEntry = agentRuntimeModule("server/registry")
      // Standalone hubAgent() also needs the app root in Node-loaded packages. Build the global's name at runtime
      // because Nitro's replace rewrites define names inside strings too.
      const appRootGlobal = [
        'const appRoot = typeof __VITEHUB_AGENT_APP_ROOT__ === "undefined" ? undefined : __VITEHUB_AGENT_APP_ROOT__',
        'if (appRoot !== undefined) Reflect.set(globalThis, ["__VITEHUB_", "AGENT_APP_ROOT", "__"].join(""), appRoot)',
        "",
      ].join("\n")
      await writeFileIfChanged(join(generatedRoot, generatedAgentRegistryDevPlugin), appRootGlobal + renderNativePackageInstallPlugin([
        {
          from: registryEntry,
          install: "installAgentRegistry",
          module: moduleImportSpecifier(join(generatedRoot, generatedAgentRegistryDevPlugin), join(generatedRoot, generatedAgentRegistry)),
        },
        // A configured KV store must come from the KV package that Vite resolves with the host's KV configuration.
        {
          from: registryEntry,
          install: "installAgentKV",
          module: config.plugins?.some(plugin => plugin.name === "@vite-hub/kv/vite")
            ? getInternalAgentOptions(agent)?.kvImport ?? frameworkOptions?.kvImport ?? "@vite-hub/kv"
            : undefined,
        },
        {
          from: registryEntry,
          install: "installAgentServerEnv",
          module: config.plugins?.some(plugin => plugin.name === "@vite-hub/env/vite") ? "#vitehub/env/server" : undefined,
        },
      ]))
    }
    // The handler names the dev server process. A CLI command that loads the project is not that server, and a
    // rewrite with its process id makes the running server rebuild and reject its own token.
    // SAFETY: Vite keeps the CLI discovery flag of the inline config on the resolved config.
    const cliDiscovery = (config as ResolvedConfig & { vitehubCliDiscovery?: unknown }).vitehubCliDiscovery === true
    if (normalized && config.command === "serve" && normalized.runtime !== "deno" && !cliDiscovery) {
      await writeFileIfChanged(join(generatedRoot, generatedAgentInvocationsDevHandler), renderViteHubNitroDevHandler({
        context: { rootDir: config.root, serverId: workspaceDevTokenServerId(config.server?.port) },
        export: "handleAgentInvocationsDevRequest",
        module: agentRuntimeModule("runtime/invocations-dev"),
      }))
    }
    if (normalized && hasHostedAgents) {
      if (normalized.runtime === "deno") {
        await writeAgentDenoServer(generatedRoot, {
          sourceRootDir: viteHubProjectRoot(config),
          standaloneChannels,
          denoCronImport: moduleImportSpecifier(
            join(generatedRoot, generatedAgentDenoServer),
            join(resolveViteHubProjectRoot(config.root), ".vitehub", "schedule", "deno-cron.mjs"),
          ),
          inspectionRoute: normalized.routes.inspection,
          libsqlState: resolveLibsqlAgentState(normalized, config),
          runtimeCapabilities: standaloneRuntimeCapabilities,
          workflowModules: getWorkflowModules(agent, frameworkOptions),
          workspaceDependencyRuntimeImports: getWorkspaceDependencyRuntimeImports(agent, frameworkOptions),
          webhookRoute: normalized.routes.webhooks,
        }, definitionServerDirs, registryDefinitions, namedChannelModuleResolver(config))
      }
      else {
        await writeAgentWebhookRouteHandler(generatedRoot, {
          standaloneChannels,
          preparation: normalized.preparation,
          webhookAliases: normalized.routes.aliases,
          cloudflareState: shouldInstallCloudflareAgentState(normalized, config),
          inspectionRoute: normalized.routes.inspection,
          libsqlState: resolveLibsqlAgentState(normalized, config),
          processDiscordGateway,
          ...(config.command === "serve" ? { runtime: "vite" as const } : {}),
          runtimeCapabilities,
          shutdown: normalized.shutdown,
          workflowModules: getWorkflowModules(agent, frameworkOptions),
          workspaceDependencyRuntimeImports: getWorkspaceDependencyRuntimeImports(agent, frameworkOptions),
          webhookRoute: normalized.routes.webhooks,
        }, definitionServerDirs)
        if (normalized.routes.discordGateway && !processDiscordGateway) {
          await writeAgentDiscordGatewayRouteHandler(generatedRoot, {
            discordGatewayRoute: normalized.routes.discordGateway,
            ...(config.command === "serve" ? { runtime: "vite" as const } : {}),
            runtimeCapabilities,
            workflowModules: getWorkflowModules(agent, frameworkOptions),
            workspaceDependencyRuntimeImports: getWorkspaceDependencyRuntimeImports(agent, frameworkOptions),
            webhookRoute: normalized.routes.webhooks,
          }, definitionServerDirs)
        }
        if (config.command === "serve" && isNetlifyHosting(config)) {
          await writeNetlifyAgentProviderOutput(config, normalized, {
            standaloneChannels,
            libsqlState: resolveLibsqlAgentState(normalized, config),
            providerImportAliases: getProviderImportAliases(agent, frameworkOptions),
            runtime: "vite",
            runtimeCapabilities: standaloneRuntimeCapabilities,
            workflowModules: getWorkflowModules(agent, frameworkOptions),
            workspaceDependencyRuntimeImports: getWorkspaceDependencyRuntimeImports(agent, frameworkOptions),
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
    resolveId: {
      // Run before Vite resolves installed optional peers to absolute module paths.
      order: "pre",
      filter: { id: /^(?:@vite-hub\/kv|@ai-sdk\/openai|advocaat)$/ },
      async handler(source, importer, options) {
        if (source === "@vite-hub/kv" && isAgentPackageImporter(importer)) {
          // Configured KV must bundle with the host's virtual config. Without hubKv(), keep the
          // optional package and its unresolved virtual config out of unrelated Agent builds.
          if (!resolved?.plugins.some(plugin => plugin.name === "@vite-hub/kv/vite")) return { external: true, id: source }
          return
        }
        if (source === chatgptModelProvider && isAgentModule(importer)) {
          // The ChatGPT model reads its plan credential through the connections runtime capability and stops with
          // AGENT_R1016 before this import when the build gives Agents none, or `connections: false`. Workers compile
          // every bundled module at isolate start, lazy ones too, so leave the package out of those builds.
          const connections = runtimeCapabilities.some(capability => capability.name === "connections" && capability.packageName !== false)
          if (resolved && !connections) return chatgptModelProviderWithoutConnections
          return
        }
        if (source !== optionalAskDriverPeer || !isAgentPackageImporter(importer)) return
        // The ask Driver imports this optional peer lazily. Keep it external when the application does not install it,
        // so Agents without driver.ask still build. An ask Driver then reports the missing package when it runs.
        return await this.resolve(source, importer, { ...options, skipSelf: true }) ?? { external: true, id: source }
      },
    },
    load(id) {
      if (id === chatgptModelProviderWithoutConnections) {
        return `export function createOpenAI() { throw new Error(${JSON.stringify("[vitehub] The ChatGPT model needs Connections. Enable connections in vitehub() and rebuild.")}) }`
      }
      // Generated code imports Agent and Workspace files by path. In `vite dev`, Node loads them, as it loads the app's imports.
      return loadNativePackageModule(id, this.environment?.name, resolved?.command ?? "build")
    },
    async configureServer(server) {
      let discoveryRefresh: Promise<void> | undefined
      let discoveryClosed = false
      const pendingDiscovery = new Map<string, boolean>()
      const refreshDiscovery = (file: string) => {
        if (!resolved || discoveryClosed) return
        const normalizedFile = file.replace(/\\/g, "/")
        const roots = serverDirs ?? [join(resolved.root, "server")]
        const relativeAgentPath = roots.map(root => `${resolve(root).replace(/\\/g, "/")}/agents/`)
          .filter(root => normalizedFile.startsWith(root))
          .map(root => normalizedFile.slice(root.length))[0]
        if (relativeAgentPath && /(?:^|\/)(?:workspace|home)\//.test(relativeAgentPath)) return
        const definitionChange = /\.agent\.(?:c|m)?[jt]s$/i.test(normalizedFile)
          || relativeAgentPath && !/(?:^|\/)skills\//.test(relativeAgentPath) && /\.(?:c|m)?[jt]s$/i.test(relativeAgentPath)
        const resourceChange = relativeAgentPath && (/\/instructions\.md$/i.test(relativeAgentPath) || /\/skills\//.test(relativeAgentPath))
        if (!definitionChange && !resourceChange && !/\.md$/i.test(normalizedFile)) return
        pendingDiscovery.set(file, Boolean(definitionChange || resourceChange))
        discoveryRefresh ??= (async () => {
          // Coalesce directory copies before writing the complete catalog.
          await new Promise(resolve => setTimeout(resolve, 0))
          while (pendingDiscovery.size && !discoveryClosed && resolved) {
            const files = [...pendingDiscovery]
            pendingDiscovery.clear()
            const changes = await Promise.all(files.map(async ([file, known]) => known || await isColocatedAgentInstructionDependency(resolved!.root, file, serverDirs)))
            if (!changes.some(Boolean)) continue
            await writeGeneratedAgentOutputs(resolved)
            const root = resolveViteHubGeneratedRoot(resolved)
            const registryPrefix = join(root, dirname(generatedAgentRegistryCatalog)).replace(/\\/g, "/") + "/"
            invalidateAgentDevModules(server, [join(root, generatedAgentRegistry).replace(/\\/g, "/")], [registryPrefix])
          }
        })().catch(error => server.config.logger.error(`[vitehub] Failed to refresh Agent discovery: ${String(error)}`)).finally(() => { discoveryRefresh = undefined })
      }
      closeDiscoveryWatcher = async () => {
        discoveryClosed = true
        pendingDiscovery.clear()
        server.watcher?.off("add", refreshDiscovery)
        server.watcher?.off("unlink", refreshDiscovery)
        await discoveryRefresh
      }
      server.watcher?.on("add", refreshDiscovery)
      server.watcher?.on("unlink", refreshDiscovery)
      // Register the Dev Loop route now; load the Agent runtime on its first request.
      const { registerAgentInvocationStreamEndpoint } = await import("./vite/invocation-stream-route.ts")
      await registerAgentInvocationStreamEndpoint(server, { runtimeCapabilities })
      // Cancel runs in the Nitro dev environment, which owns the application's journals and abort handles.
      registerViteHubNitroDevEndpoint(server, {
        ...agentInvocationsDevGuard,
        nitroBaseURL: () => {
          // SAFETY: Vite keeps unknown user config keys on the resolved config. Nitro reads the same `nitro` key.
          const baseURL = (resolved as (ResolvedConfig & { nitro?: { baseURL?: unknown } }) | undefined)?.nitro?.baseURL
          return typeof baseURL === "string" ? baseURL : process.env.NITRO_APP_BASE_URL
        },
        route: agentInvocationsDevRoute,
        runtimeRoute: agentInvocationsDevRuntimeRoute,
        discovery: { workspaceDevTokenServerId: workspaceDevTokenServerId(server.config.server.port) },
        authorize: async req => req.headers[agentInvocationsDevTokenServerHeader] !== workspaceDevTokenServerId(server.config.server.port) || !await validateWorkspaceDevToken(server.config.root, req.headers, { serverId: workspaceDevTokenServerId(server.config.server.port) })
          ? new Response("Forbidden Agent Invocations Dev token.", { status: 403 })
          : undefined,
        forwardHeaders: [workspaceDevTokenHeader, agentInvocationsDevTokenServerHeader],
        unavailable: { code: agentInvocationsDevRuntimeUnavailableCode, message: agentInvocationsDevRuntimeUnavailableMessage },
      })
    },
    async handleHotUpdate(context) {
      const file = context.file.replace(/\\/g, "/")
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
      if (resolved) await writeGeneratedAgentOutputs(resolved)
      const moduleIds: string[] = []
      if (resolved) {
        const root = resolveViteHubGeneratedRoot(resolved)
        moduleIds.push(join(root, generatedAgentRegistry).replace(/\\/g, "/"))
        const registryPrefix = join(root, dirname(generatedAgentRegistryCatalog)).replace(/\\/g, "/") + "/"
        for (const module of context.server.moduleGraph.idToModuleMap.values()) {
          const id = module.id?.replace(/\\/g, "/")
          if (id?.startsWith(registryPrefix)) moduleIds.push(id)
        }
      }
      if (resolved?.root && colocatedResourceUpdate) {
        moduleIds.push(...discoverProjectAgentDefinitions(resolved.root, serverDirs).map(definition => definition.handler.replace(/\\/g, "/")))
        const root = resolveViteHubGeneratedRoot(resolved)
        moduleIds.push(...[
          generatedAgentDenoServer,
          generatedAgentDiscordGatewayRouteHandler,
          generatedAgentDiscordGatewayPlugin,
          generatedAgentNetlifyFunction,
          generatedAgentWebhookRouteHandler,
          generatedAgentDeclaredWebhookRouteHandler,
          generatedAgentWebhookQueuePlugin,
        ].map(handler => join(root, handler).replace(/\\/g, "/")))
      }
      invalidateAgentDevModules(context.server, moduleIds)
    },
    transform: {
      // Only project modules and the generated Workflow registry change, and both are JavaScript or TypeScript.
      filter: { id: /\.[cm]?[jt]s(?:[?#]|$)/i },
      async handler(code, id) {
        if (!resolved?.root) return
        const normalizedId = id.split(/[?#]/, 1)[0]!.replace(/\\/g, "/")
        const typescriptModule = /\.(?:c|m)?[jt]s$/i.test(normalizedId)
        const definitionServerDirs = serverDirs ?? [join(resolved.root, "server")]
        const serverProjectModule = definitionServerDirs.some(directory =>
          normalizedId.startsWith(`${resolve(directory).replace(/\\/g, "/")}/`),
        )
        // Configured server directories can belong to installed Nuxt layers and still need project transforms.
        // Skip other installed packages to avoid parsing dependencies on the first dev request.
        const projectModule = typescriptModule
          && (serverProjectModule
            || (!normalizedId.includes("/node_modules/") && normalizedId.startsWith(`${resolve(resolved.root).replace(/\\/g, "/")}/`)))
        let transformed = code
        if (projectModule) {
          const agentModule = /\.agent\.(?:c|m)?[jt]s$/i.test(normalizedId)
            || definitionServerDirs.some(directory => normalizedId.startsWith(`${resolve(directory, "agents").replace(/\\/g, "/")}/`))
          const definition = agentModule && discoverProjectAgentDefinitions(resolved.root, serverDirs)
            .find(definition => definition.handler.replace(/\\/g, "/") === normalizedId)
          if (definition) {
            const skills = readColocatedAgentSkills(definition.handler)
            transformed = decorateDiscoveredAgentExport(transformed, value => this.parse(value), [
              ...declaredWorkspaceDecorators(definition),
              ...(skills ? [colocatedAgentSkillsDecorator(skills)] : []),
              discoveredAgentIdentityDecorator(definition),
            ]) ?? transformed
          }
          if (definition) {
            transformed = await transformNamedAgentChannels(transformed, value => this.parse(value), normalizedId, discoverAgentChannelModules(definitionServerDirs), namedChannelModuleResolver(resolved!)) ?? transformed
          }
          if (transformed !== code) return transformed
        }
        if (isGeneratedAgentWorkflowRegistryId(normalizedId)) {
          return transformGeneratedAgentWorkflowRegistry(
            code,
            runtimeCapabilities,
            workflowState(resolved!),
          )
        }
      },
    },
    vitehub: {
      durability: () => stateDurability
        ? [{ export: "agentStateDurability", input: stateDurability, module: resolveDurabilityModule(import.meta.url, "@vite-hub/agent/durability"), primitive: "agent-state" }]
        : [],
      // The Console, `vitehub channels`, and agents run these. The app imports them through `vite-hub`.
      operations: () => [{ export: "agentChannelOperations", load: async () => (await import(/* @vite-ignore */ import.meta.url.endsWith(".ts") ? "./operations.ts" : "./operations.js")).agentChannelOperations, module: agentRuntimeModule("operations") }],
      providerOutput: {
        async prepareSources(sources) {
          if (!resolved) return
          await prepareRetainedAgentSources(sources, discoverProjectAgentDefinitions(resolved.root, serverDirs),
            discoverAgentChannelModules(serverDirs ?? [join(resolved.root, "server")]), namedChannelModuleResolver(resolved))
        },
      },
      agent: {
        workflowModules: {
          index: agentRuntimeModule("index"),
          runtimeWorkflow: agentRuntimeModule("runtime/workflow"),
          serverInternal: agentRuntimeModule("server/internal"),
        },
        async transformWorkspaceAgent(code, id, { root, serverDirs }) {
          const file = id.split(/[?#]/, 1)[0]!.replace(/\\/g, "/")
          const roots = serverDirs ?? [join(root, "server")]
          if (!/\.agent\.(?:c|m)?[jt]s$/i.test(file)
            && !roots.some(directory => file.startsWith(`${resolve(directory, "agents").replace(/\\/g, "/")}/`))) return
          const definition = discoverProjectAgentDefinitions(root, serverDirs)
            .find(definition => definition.handler.replace(/\\/g, "/") === file)
          if (!definition || !checksDeclaredWorkspace(definition)) return
          return decorateDiscoveredAgentExport(code, await parseTypeScript(), declaredWorkspaceDecorators(definition))
        },
        transformWorkflowRegistry: (code, id) => isGeneratedAgentWorkflowRegistryId(id)
          ? transformGeneratedAgentWorkflowRegistry(
              code,
              runtimeCapabilities,
              workflowState(resolved!),
            )
          : code,
      },
      cli: async () => {
        const { createAgentCliContributor } = await import(/* @vite-ignore */ "./cli.js")
        if (agent?.cli === false) return createAgentCliContributor(false)
        return createAgentCliContributor({
          envDir: resolved?.envDir,
          eval: agent?.eval,
          rootDir: resolved?.root ?? process.cwd(),
          serverDirs,
        })
      },
      inspect: () => {
        const options = normalizeAgentOptions(agent)
        const rootDir = resolve(resolved?.root ?? process.cwd())
        return {
          definitions: [{
            kind: "agent",
            label: "Agents",
            list: () => {
              const rootDir = resolve(resolved?.root ?? process.cwd())
              return inspectAgentDefinitions({ projectRoot: resolveViteHubProjectRoot(rootDir), rootDir, serverDirs })
            },
          }],
          providerOutput: [
            ...(options !== false && options?.runtime === "deno" && hasHostedAgentDefinitions(rootDir, serverDirs)
              ? [{ description: "Generated Deno Agent server", owner: "agent", path: join(rootDir, ".vitehub", "agent", "deno-server.ts") }]
              : []),
            ...(options !== false && options?.runtime !== "deno" && hasHostedAgentDefinitions(rootDir, serverDirs) && resolveAgentHosting(resolved) === "netlify"
              ? [{ description: "Generated Netlify Agent function", owner: "agent", path: join(createDefaultNetlifyOutputRoot(rootDir), "functions", `${netlifyAgentFunctionName}.mjs`) }]
              : []),
          ],
        }
      },
    },
    config(config, environment) {
      const resolved = normalizeAgentOptions(agent)
      serverDirs = (config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS] ?? serverDirs
      const root = resolve(config.root || process.cwd())
      if (hasNitroConfigContext(config)) {
        runtimeCapabilities = configuredGeneratedAgentRuntimeCapabilities(
          (config.plugins || []).filter(Boolean) as Plugin[],
          getInternalAgentOptions(agent)?.runtimeCapabilityImports ?? frameworkOptions?.runtimeCapabilityImports,
          viteHubProjectRoot(config),
        )
      }
      const generatedRoot = resolveViteHubGeneratedRoot(config)
      const nitroContext = hasNitroConfigContext(config)
      const standaloneChannels = resolved ? discoverStandaloneChannels(viteHubProjectRoot(config), serverDirs ?? [join(root, "server")]) : []
      const hasHostedAgents = Boolean(resolved && hasHostedAgentDefinitions(root, serverDirs, standaloneChannels))
      const hasAgentDefinitions = Boolean(resolved && discoverProjectAgentDefinitions(root, serverDirs).length)
      const denoOutput = resolved && resolved.runtime === "deno"
      if (standaloneChannels.some(channel => channel.inbound) && (denoOutput || resolveAgentHosting(config) === "netlify")) {
        const names = listedAgentChannelNames(discoverAgentDefinitions({ mode: "server-agents", scanDirs: serverDirs ?? [join(root, "server")] }))
        const unclaimed = standaloneChannels.find(channel => channel.inbound && !names.has(channel.name))
        if (unclaimed) throw agentDiagnostics.AGENT_B0024({ message: `[vitehub] Channel ${unclaimed.handler} declares its own webhook route. Inbound Channels that no Agent lists currently require a Nitro host.` })
      }
      const webhookAliases = resolved ? standaloneChannelWebhookAliases(standaloneChannels, resolved.routes.aliases) : {}
      if (resolved && Object.keys(resolved.routes.aliases || {}).length && (denoOutput || resolveAgentHosting(config) === "netlify")) {
        throw agentDiagnostics.AGENT_B0006({ message: "[vitehub] Webhook aliases currently require a Nitro host." })
      }
      const installCloudflareState = hasHostedAgents && !denoOutput && shouldInstallCloudflareAgentState(resolved, config, environment?.command)
      installsCloudflareState ||= installCloudflareState
      const stateDriver = resolved && resolved.providers.state.driver
      stateDurability = resolved && hasHostedAgents && !denoOutput ? agentStateDurabilityInput(resolved, environment ? { ...config, command: environment.command } : config, installCloudflareState) : undefined
      const installWebhookQueue = Boolean(
        resolved
        && hasHostedAgents
        && !denoOutput
        && !installCloudflareState
        && (stateDriver === "auto" || stateDriver === "sqlite" || stateDriver === "libsql"),
      )
      const installProcessDiscordGateway = Boolean(
        resolved
        && hasHostedAgents
        && !denoOutput
        && getInternalAgentOptions(agent)?.processDiscordGateway,
      )
      const installPreparation = Boolean(resolved && hasHostedAgents && !denoOutput && resolved.preparation)
      const processHostAgents = resolved && hasHostedAgents
        ? discoverProcessHostAgentNames(discoverAgentDefinitions({ mode: "server-agents", scanDirs: serverDirs ?? [join(root, "server")] }))
        : []
      if (processHostAgents.length) {
        const hosting = denoOutput ? "deno" : resolveAgentHosting(config)
        if (hosting) {
          throw agentDiagnostics.AGENT_B0022({ message: `[vitehub] Agent ${processHostAgents.map(name => `"${name}"`).join(", ")} uses a preset that runs a long-lived process host. ${hosting} cannot run it; deploy with the Node server preset.` })
        }
        if (!installWebhookQueue) {
          throw agentDiagnostics.AGENT_B0023({ message: `[vitehub] Agent ${processHostAgents.map(name => `"${name}"`).join(", ")} stores its process host state in Agent State. Use the sqlite, libsql, or auto Agent State provider.` })
        }
      }
      const applicationHandlers = (config as { nitro?: { handlers?: unknown } }).nitro?.handlers
      const applicationOwnsReadyRoute = Array.isArray(applicationHandlers) && applicationHandlers.some(handler => isRecord(handler) && handler.route === agentReadyRoute)
      const nitroHandlers = [
        ...(installPreparation && resolved && resolved.preparation
          ? [{ handler: join(generatedRoot, generatedAgentPreparationHandler), route: resolved.preparation.route || agentReadyRoute }]
          : []),
        ...(installWebhookQueue && !installPreparation && !applicationOwnsReadyRoute
          ? [{ handler: join(generatedRoot, generatedAgentReadyHandler), route: agentReadyRoute }]
          : []),
        ...(resolved && hasHostedAgents && !denoOutput && resolved.routes.inspection
          ? [{
              handler: join(generatedRoot, generatedAgentWebhookRouteHandler),
              route: normalizeNitroRoute(resolved.routes.inspection),
            }]
          : []),
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
        ...(resolved && hasHostedAgents && !denoOutput
          ? [{ handler: join(generatedRoot, generatedAgentDeclaredWebhookRouteHandler), middleware: true, route: "/**" }]
          : []),
        ...(processHostAgents.length
          ? [
              { handler: join(generatedRoot, generatedAgentProcessHostsDrain), route: agentProcessHostDrainRoute },
              { handler: join(generatedRoot, generatedAgentProcessHostsHealth), route: agentProcessHostHealthRoute },
            ]
          : []),
        ...(resolved && hasHostedAgents && !denoOutput && resolved.routes.discordGateway && !installProcessDiscordGateway
          ? [{
              handler: join(generatedRoot, generatedAgentDiscordGatewayRouteHandler),
              route: normalizeNitroRoute(resolved.routes.discordGateway),
            }]
          : []),
      ]
      // `vitehub agent invocations cancel` runs in the Nitro runtime, so it reaches the application's journals.
      // The handler exists only for the Development Server.
      // CLI discovery resolves the application config to collect contributors; it does not start Nitro.
      // The Console's discovery config intentionally includes its broad /_vitehub/** route, so do not
      // install or validate the development-only invocation handler in that mode.
      // SAFETY: Vite preserves the optional discovery flag; both flags are checked against true.
      const cliDiscovery = (config as { server?: { middlewareMode?: unknown }, vitehubCliDiscovery?: unknown }).vitehubCliDiscovery === true
        || (config as { server?: { middlewareMode?: unknown } }).server?.middlewareMode === true
      const devNitroHandlers = normalizeAgentOptions(agent) && !denoOutput && nitroContext && !cliDiscovery && environment?.command === "serve"
        ? [{ handler: join(generatedRoot, generatedAgentInvocationsDevHandler), route: agentInvocationsDevRuntimeRoute }]
        : []
      const nitro = installCloudflareState
        ? mergeCloudflareAgentStateNitroConfig(
            (config as { nitro?: unknown }).nitro,
            agentRuntimeModule("cloudflare/state"),
          )
        : cloneNitroConfig((config as { nitro?: unknown }).nitro)
      if (resolved && hasHostedAgents && !denoOutput && Object.keys(webhookAliases).length) {
        const existing = Array.isArray(nitro.handlers) ? nitro.handlers : []
        const routes = existing.filter(isRecord).flatMap(handler => typeof handler.route === "string" ? [{ route: handler.route, middleware: handler.middleware === true }] : [])
        for (const [path, target] of Object.entries(webhookAliases)) {
          if (typeof target?.agent !== "string" || !target.agent.trim() || typeof target?.webhook !== "string" || !target.webhook.trim()) {
            throw agentDiagnostics.AGENT_B0006({ message: "[vitehub] Webhook aliases require an Agent name and webhook name." })
          }
          const route = validateAgentStaticRoute(path, [...routes, ...nitroHandlers, ...devNitroHandlers], "webhook alias")
          nitroHandlers.push({ handler: join(generatedRoot, generatedAgentWebhookRouteHandler), route })
        }
      }
      if (installPreparation && resolved && resolved.preparation) {
        const existing = Array.isArray(nitro.handlers) ? nitro.handlers : []
        const routes = existing.filter(isRecord).flatMap(handler => typeof handler.route === "string" ? [{ route: handler.route, middleware: handler.middleware === true }] : [])
        const preparationHandler = nitroHandlers.find(handler => handler.handler === join(generatedRoot, generatedAgentPreparationHandler))!
        preparationHandler.route = validateAgentStaticRoute(preparationHandler.route, [
          ...routes,
          ...nitroHandlers.filter(handler => handler.handler !== join(generatedRoot, generatedAgentPreparationHandler)),
          ...devNitroHandlers,
        ])
      }
      if (devNitroHandlers.length) {
        const existing = Array.isArray(nitro.handlers) ? nitro.handlers : []
        const routes = existing.filter(isRecord).flatMap(handler => typeof handler.route === "string" ? [{ route: handler.route, middleware: handler.middleware === true }] : [])
        for (const handler of devNitroHandlers) {
          handler.route = validateAgentStaticRoute(handler.route, [
            ...routes,
            ...nitroHandlers,
            ...devNitroHandlers.filter(candidate => candidate !== handler),
          ], "development invocation", agentInvocationsDevRuntimeNamespace)
        }
      }
      const mergedAgentNitro = (nitroContext ? mergeAgentNitroExternals : cloneNitroConfig)(mergeNitroPlugins(
        guardAgentDevelopmentRoutes(mergeNitroHandlers(nitro, [...nitroHandlers, ...devNitroHandlers]), devNitroHandlers),
        [
          ...(installPreparation ? [join(generatedRoot, generatedAgentPreparationPlugin)] : []),
          ...(installWebhookQueue ? [join(generatedRoot, generatedAgentWebhookQueuePlugin)] : []),
          ...(installProcessDiscordGateway ? [join(generatedRoot, generatedAgentDiscordGatewayPlugin)] : []),
          ...(processHostAgents.length ? [join(generatedRoot, generatedAgentProcessHostsPlugin)] : []),
        ],
        normalizeAgentOptions(agent) && nitroContext && !cliDiscovery && environment?.command === "serve" ? join(generatedRoot, generatedAgentRegistryDevPlugin) : undefined,
      ))
      const mergedNitro = nitroContext && hasAgentDefinitions && !denoOutput
        ? installAgentProviderRuntimePackages(mergedAgentNitro, root)
        : mergedAgentNitro
      if (nitroContext) {
        const replacement = isRecord(mergedNitro.replace) ? mergedNitro.replace : {}
        mergedNitro.replace = {
          __VITEHUB_AGENT_APP_ROOT__: JSON.stringify(root),
          ...replacement,
        }
      }
      const workerAliases = resolved && resolveAgentHosting(config) === "cloudflare" ? resolveWorkerPackageAliases() : {}
      if (resolved) {
        const alias = isRecord(mergedNitro.alias) ? { ...mergedNitro.alias } : {}
        alias[agentRegistryId] = join(generatedRoot, generatedAgentRegistry)
        mergedNitro.alias = { ...workerAliases, ...alias }
      }
      const result: UserConfig = {
        define: {
          __VITEHUB_AGENT_APP_ROOT__: JSON.stringify(root),
          ...config.define,
        },
        server: {
          watch: config.server?.watch === null ? null : {
            ignored: generatedViteHubWatchIgnoredAddition(config.server?.watch?.ignored),
          },
        },
      }
      if (resolved) {
        // Vite prepends returned aliases. Append Worker fallbacks in place so user aliases match first.
        const configuredAliases = config.resolve?.alias
        config.resolve = {
          ...config.resolve,
          alias: Array.isArray(configuredAliases)
            ? [...configuredAliases, ...Object.entries(workerAliases).map(([find, replacement]) => ({ find, replacement }))]
            : { ...workerAliases, ...configuredAliases },
        }
        result.resolve = { alias: { [agentRegistryId]: join(generatedRoot, generatedAgentRegistry) } }
      }
      if (nitroHandlers.length) {
        // SAFETY: Vite's build options accept the Rolldown external field merged by this boundary.
        result.build = mergeBuildExternal(config as BuildWithRolldownOptions, optionalAgentRuntimeExternals)
      }
      if (nitroContext || nitroHandlers.length || installCloudflareState || installProcessDiscordGateway) {
        // Replace the Nitro config in place. Vite concatenates arrays when it merges a returned config,
        // so returning the complete Nitro config would repeat every user entry, such as Wrangler secrets.
        // SAFETY: Nitro's Vite plugin reads this open `nitro` key from the user config; mergedNitro starts from its value.
        ;(config as { nitro?: NitroConfig }).nitro = mergedNitro
      }
      return result
    },
    async configResolved(config) {
      resolved = config
      providerOutput = useProviderOutputCatalog(config)
      installsCloudflareState ||= shouldInstallCloudflareAgentState(normalizeAgentOptions(agent), config)
      // SAFETY: ViteHub's config hook adds this private server-directory symbol before config resolution.
      serverDirs = (config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS] ?? serverDirs
      const build = { agent, config, providerOutput, serverDirs, runtimeCapabilities: new Array<GeneratedAgentRuntimeCapability>() }
      buildConfigs.set(config, build)
      const generatedRoot = resolveViteHubGeneratedRoot(config)
      await prepareSourceDefinitions(config, viteHubProjectRoot(config), serverDirs)
      runtimeCapabilities = resolveGeneratedAgentRuntimeCapabilities(
        config,
        getInternalAgentOptions(agent)?.runtimeCapabilityImports ?? frameworkOptions?.runtimeCapabilityImports,
      )
      standaloneRuntimeCapabilities = await writeStandaloneAgentRuntimeCapabilities(config, runtimeCapabilities)
      build.runtimeCapabilities = standaloneRuntimeCapabilities
      await writeGeneratedAgentOutputs(config)
      const configs = (scheduledBuildConfigsByRoot.get(config.root) ?? []).filter(previous => previous !== config)
      configs.push(config)
      scheduledBuildConfigsByRoot.set(config.root, configs)
      if (!discoverAgentEvalFiles([config.root, ...(serverDirs ?? [])]).length) {
        await removeAgentEvaliteConfig(config.root, generatedRoot)
        return
      }

      const evalOptions = resolveAgentEvalOptions(agent?.eval)
      await writeAgentEvaliteConfig(config.root, evalOptions, generatedRoot)
    },
    configEnvironment(name, config, env) {
      if (!isServerEnvironment(name, config)) {
        return
      }

      return {
        // SAFETY: Vite passes its environment build configuration, which this adapter augments without changing its owned fields.
        build: mergeBuildExternal(config as BuildWithRolldownOptions, []),
        ...(loadsViteHubPackagesNatively(name, env) ? {} : { resolve: { noExternal: mergeNoExternal(config.resolve?.noExternal) } }),
      }
    },
    buildApp: providerOutputEnvironment.buildApp,
    nitro: providerOutputEnvironment.nitro,
    buildStart() {
      if (providerOutputEnvironment.defers(this)) return
      const context = buildEnvironment(this)
      rejectedBuilds.delete(context)
      const environmentConfig = this?.environment?.config
      if (environmentConfig) {
        const candidates = scheduledBuildConfigsByRoot.get(environmentConfig.root) ?? []
        const direct = buildConfigs.get(environmentConfig)
        const catalog = getProviderOutputCatalog(environmentConfig)
        const matches = catalog
          ? candidates.filter(candidate => buildConfigs.get(candidate)?.providerOutput === catalog)
          : candidates.filter(candidate => candidate.build === environmentConfig.build)
        if (!direct && matches.length !== 1) {
          rejectedBuilds.add(context)
          throw agentDiagnostics.AGENT_B0020({ root: environmentConfig.root })
        }
        const scheduledConfig = matches[0]
        const scheduled = direct ?? (scheduledConfig && buildConfigs.get(scheduledConfig))
        buildConfigs.set(context, {
          agent: scheduled ? scheduled.agent : options,
          config: environmentConfig,
          providerOutput: scheduled?.providerOutput ?? useProviderOutputCatalog(environmentConfig),
          // SAFETY: The framework owns this optional server-directory symbol on Vite configs.
          serverDirs: scheduled?.serverDirs ?? (environmentConfig as typeof environmentConfig & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS],
          runtimeCapabilities: scheduled?.runtimeCapabilities ?? [],
        })
      } else if (resolved) {
        buildConfigs.set(context, { agent, config: resolved, providerOutput, serverDirs, runtimeCapabilities: standaloneRuntimeCapabilities })
      }
      providerOutputGenerations.capture(this, buildConfigs.get(context)?.providerOutput ?? providerOutput)
    },
    generateBundle(_options, bundle) {
      // Worker builds resolve the provider runtime to a stub. Only codexDriver() and claudeCodeDriver() import it,
      // so the stub is in the output only when the Worker can reach a provider Driver.
      const usesProviderDriver = Object.values(bundle).some(output => output.type === "chunk"
        && output.moduleIds.some(id => providerAgentWorkerStub.test(id.replace(/\\/g, "/"))))
      if (usesProviderDriver) throw agentDiagnostics.AGENT_B0019()
    },
    async buildEnd(error) {
      if (rejectedBuilds.has(buildEnvironment(this)) || providerOutputEnvironment.defers(this)) return
      const build = buildConfigs.get(buildEnvironment(this))
      if (error) {
        await providerOutputGenerations.reset(this, build?.providerOutput ?? providerOutput, error)
        return
      }
      const config = build?.config ?? resolved
      const buildAgent = build ? build.agent : agent
      const buildServerDirs = build ? build.serverDirs : serverDirs
      if (!config || config.command !== "build") return
      let artifactDir: string | undefined
      try {
        const normalized = normalizeAgentOptions(buildAgent)
        const definitions = normalized && isNetlifyHosting(config)
        ? [
            ...discoverAgentDefinitions({ mode: "vite-suffix", rootDir: config.root }),
            ...discoverAgentDefinitions({ mode: "server-agents", scanDirs: buildServerDirs ?? [join(config.root, "server")] }),
          ]
          : []
        const hostedDefinitions = definitions.filter(definition => definition.source === "server-agents" || definition.source === "server-agent" || definition.source === "server-agent-workspace")
        artifactDir = definitions.length
          ? resolve(config.root, ".vitehub/agent-generations", randomUUID())
          : undefined
        const contributionArtifactDir = artifactDir
        const providerImportAliases = getProviderImportAliases(buildAgent, frameworkOptions) ?? {}
        const channelModules = definitions.length ? discoverAgentChannelModules(buildServerDirs ?? [join(config.root, "server")]) : []
        const channelNames = listedAgentChannelNames(hostedDefinitions)
        const standaloneChannels = normalized && isNetlifyHosting(config)
          ? discoverStandaloneChannels(viteHubProjectRoot(config), buildServerDirs ?? [join(config.root, "server")]).filter(channel => channelNames.has(channel.name))
          : []
        const parse = await parseTypeScript()
        const definitionSources = await Promise.all(definitions.map(async (definition) => {
          const instructionDependencies = new Set<string>()
          const instructions = await readColocatedAgentInstructions(definition.handler, { dependencies: instructionDependencies })
          const skillsRoot = resolveColocatedAgentSkillsRoot(definition.handler)
          const workspaceRoot = resolveColocatedAgentWorkspaceRoot(definition.handler)
          const channels = await namedAgentChannelModules(await readFile(definition.handler, "utf8"), parse, definition.handler, channelModules, namedChannelModuleResolver(config))
          return {
            definition,
            instructions,
            paths: [
              definition.handler,
              ...channels.map(channel => channel.handler),
              ...instructionDependencies,
              ...(skillsRoot ? [skillsRoot] : []),
              ...(workspaceRoot ? [workspaceRoot] : []),
            ],
          }
        }))
        const definitionSourcePaths = definitionSources.flatMap(source => source.paths)
        const retainedSources = contributionArtifactDir
          ? await retainProviderOutputSources({
              artifactDir: resolve(contributionArtifactDir, "sources"),
              paths: [
                ...definitionSourcePaths,
                // Standalone capabilities can import generated app modules, such as the Email definition.
                ...(build?.runtimeCapabilities ?? standaloneRuntimeCapabilities).flatMap(capability =>
                  typeof capability.packageName === "string" && capability.packageName.startsWith(".")
                    ? [resolve(resolveViteHubGeneratedRoot(config), "agent", capability.packageName)]
                    : []),
                ...providerOutputAliasSources(providerImportAliases, [config.root]),
              ],
              roots: [config.root],
            })
          : undefined
        const retainedDefinitions = definitionSources.map(source => ({
          ...source.definition,
          [retainedColocatedInstructions]: source.instructions,
          handler: retainedSources?.resolve(source.definition.handler) ?? source.definition.handler,
        }))
        if (retainedSources && normalized) {
          await prepareRetainedAgentSources(retainedSources, definitions, channelModules, namedChannelModuleResolver(config))
          const retainedGeneratedRoot = join(retainedSources.resolve(config.root), ".vitehub")
          const agentHost = hostedDefinitions.length > 0 && normalized.runtime !== "deno"
          await writeAgentRuntimeRegistry(retainedGeneratedRoot, retainedDefinitions, {
            agentHost,
          })
          if (agentHost) {
            const handlerPath = join(retainedGeneratedRoot, generatedAgentWebhookRouteHandler)
            await writeFile(handlerPath, await generateAgentNetlifyFunctionRouteHandler(retainedDefinitions.filter(definition => hostedDefinitions.some(hosted => hosted.name === definition.name)), handlerPath, {
              standaloneChannels,
              inspectionRoute: normalized.routes.inspection,
              libsqlState: resolveLibsqlAgentState(normalized, config),
              runtimeCapabilities: build?.runtimeCapabilities ?? standaloneRuntimeCapabilities,
              workflowModules: getWorkflowModules(buildAgent, frameworkOptions),
              workspaceDependencyRuntimeImports: getWorkspaceDependencyRuntimeImports(buildAgent, frameworkOptions),
              webhookRoute: normalized.routes.webhooks,
            }), "utf8")
          }
        }
        const retainedProviderImportAliases = {
          ...(retainedSources ? retainProviderOutputAliases(providerImportAliases, retainedSources) : providerImportAliases),
          ...(normalized ? { [agentRegistryId]: retainedSources
            ? join(retainedSources.resolve(config.root), ".vitehub", generatedAgentRegistry)
            : join(resolveViteHubGeneratedRoot(config), generatedAgentRegistry) } : {}),
        }
        const buildProviderOutput = build?.providerOutput ?? providerOutput
        contributeProviderDeploymentOutput(buildProviderOutput, {
          discard: contributionArtifactDir ? async () => await removeProviderOutputArtifactDir(contributionArtifactDir) : undefined,
          owner: "agent",
          rootDir: config.root,
          write: async ({ signal, write }) => {
          if (normalized && normalized.runtime === "deno") return
          if (normalized && hostedDefinitions.length && isNetlifyHosting(config)) {
            await writeNetlifyAgentProviderOutput(config, normalized, {
              standaloneChannels,
              libsqlState: resolveLibsqlAgentState(normalized, config),
              providerImportAliases: retainedProviderImportAliases,
              runtimeCapabilities: build?.runtimeCapabilities ?? standaloneRuntimeCapabilities,
              sourceRootDir: retainedSources?.resolve(config.root),
              workflowModules: getWorkflowModules(buildAgent, frameworkOptions),
              workspaceDependencyRuntimeImports: getWorkspaceDependencyRuntimeImports(buildAgent, frameworkOptions),
            }, buildServerDirs, write, retainedDefinitions.filter(definition => definition.source === "server-agents" || definition.source === "server-agent" || definition.source === "server-agent-workspace"), contributionArtifactDir ? resolve(contributionArtifactDir, "sources") : undefined)
          }
          else if (isNetlifyHosting(config)) {
            await cleanupNetlifyAgentProviderOutput(config, write)
          }
          signal.throwIfAborted()
          await copyVercelFunctionRuntimePackages({
            packages: () => [
              { includePeerDependencies: true, name: "@ai-sdk/mcp", optional: true },
              { includePeerDependencies: true, name: "@t3tools/provider-runtime", optional: true },
              ...resolveProviderRuntimePackages({ rootDir: config.root }),
            ],
            rootDir: config.root,
            signal,
          })
          },
        }, providerOutputGenerations.get(this))
      }
      catch (error) {
        if (artifactDir) await removeProviderOutputArtifactDir(artifactDir)
        await providerOutputGenerations.reset(this, build?.providerOutput ?? providerOutput, error)
        throw error
      }
    },
    async renderError(error) {
      if (rejectedBuilds.has(buildEnvironment(this)) || providerOutputEnvironment.defers(this)) return
      const build = buildConfigs.get(buildEnvironment(this))
      await providerOutputGenerations.reset(this, build?.providerOutput ?? providerOutput, error)
    },
    closeBundle: {
      order: "post",
      sequential: true,
      async handler() {
        if (rejectedBuilds.has(buildEnvironment(this))) return
        await closeDiscoveryWatcher?.()
        setChannelSimulation(false)
        if (providerOutputEnvironment.defers(this)) return
        const build = buildConfigs.get(buildEnvironment(this))
        const config = build?.config ?? this?.environment?.config ?? resolved
        if (!config || config.command !== "build") return
        await finalizeProviderDeploymentOutputs(build?.providerOutput ?? providerOutput)
      },
    },
  }
}

export function discoverAgentDefinitionEntries(
  root: string,
  serverDirs?: string[],
): Array<{ handler: string, name: string }> {
  const resolvedServerDirs = serverDirs ?? [join(root, "server")]
  const entries = [
    ...discoverAgentDefinitions({ mode: "vite-suffix", rootDir: root }),
    ...discoverAgentDefinitions({ mode: "server-agents", scanDirs: resolvedServerDirs }),
  ]
  const names = new Set<string>()
  for (const entry of entries) {
    if (names.has(entry.name)) throw new Error(`Duplicate Agent name "${entry.name}" discovered.`)
    names.add(entry.name)
  }
  return [...new Map(entries.map(definition => [definition.handler, {
    handler: definition.handler,
    name: definition.name,
  }])).values()].sort((left, right) => left.name.localeCompare(right.name) || left.handler.localeCompare(right.handler))
}

export interface AgentInspectionOptions {
  projectRoot: string
  rootDir: string
  serverDirs?: string[]
}

/** Lists Agent Definitions as serializable inspection summaries. */
export function inspectAgentDefinitions(options: AgentInspectionOptions): ViteHubDefinitionSummary[] {
  return summarizeDefinitions(options.projectRoot, discoverAgentDefinitionEntries(options.rootDir, options.serverDirs), "agent")
}


export { processAgentHost } from './process-host-vite.ts'

export { agentHostRoutes } from './host-routes-vite.ts'
export type { AgentHostRoute } from './host-routes-vite.ts'
