import { existsSync, readFileSync, statSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"

import { writeProviderDeploymentOutputs } from "@vite-hub/internal/build/deployment-output"
import { copyVercelFunctionRuntimePackages } from "@vite-hub/internal/build/vercel-runtime-packages"
import { createNoExternalMerger, isServerEnvironment, mergeGeneratedViteHubWatchIgnored } from "@vite-hub/internal/build/vite"

import { chatDevTools } from "./chat/devtools.ts"
import { registerChatDevtoolsBridge } from "./chat/vite/devtools-bridge.ts"
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
const netlifyAgentFunctionName = "vitehub-agent"
const workspacePackageName = "@vite-hub/workspace"
const optionalNetlifyAgentBundleExternals = [
  "@ai-sdk/harness",
  "@ai-sdk/harness/*",
  "@ai-sdk/mcp",
  "@ai-sdk/sandbox-vercel",
  "@modelcontextprotocol/sdk/*",
  "@vite-hub/sandbox",
  "@vite-hub/sandbox/*",
  "@vite-hub/shell",
  "@vite-hub/shell/*",
  "@vite-hub/workflow",
  "@vite-hub/workflow/*",
  "agents",
  "evalite/*",
  "vitest/*",
]

interface InternalAgentModuleOptions extends AgentModuleOptions {
  importBase?: string
  workspaceImportBase?: string
}

interface AgentGeneratedImportOptions {
  agentImportBase?: string
  workspaceImportBase?: string
}

function getInternalAgentOptions(options: AgentModuleOptions | false | undefined): InternalAgentModuleOptions | undefined {
  return options && typeof options === "object" ? options as InternalAgentModuleOptions : undefined
}

function getAgentImportBase(options: AgentModuleOptions | false | undefined): string {
  return getInternalAgentOptions(options)?.importBase ?? agentPackageName
}

function getWorkspaceImportBase(options: AgentModuleOptions | false | undefined): string {
  return getInternalAgentOptions(options)?.workspaceImportBase ?? workspacePackageName
}

function subpath(base: string, path: string): string {
  return `${base}/${path}`
}

type NitroConfig = Record<string, unknown> & CloudflareAgentStateRollupTarget & CloudflareAgentStateTarget
type RollupExternalFunction = (source: string, importer?: string, isResolved?: boolean) => boolean | null | undefined | void
type GeneratedLibsqlAgentStateOptions = Pick<ResolvedAgentModuleOptions["providers"]["state"], "tablePrefix" | "url">

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function shouldInstallCloudflareAgentState(options: false | ResolvedAgentModuleOptions): options is ResolvedAgentModuleOptions {
  if (!options || !options.routes.webhooks) return false
  const provider = options.providers.state.provider
  return provider === "auto" || provider === "cloudflare" || provider === "cloudflare-agents"
}

function resolveLibsqlAgentState(options: false | ResolvedAgentModuleOptions): GeneratedLibsqlAgentStateOptions | undefined {
  if (!options || !options.routes.webhooks) return
  const { provider, tablePrefix, url } = options.providers.state
  if (provider !== "sqlite" && provider !== "libsql") return
  return {
    ...(tablePrefix ? { tablePrefix } : {}),
    ...(url ? { url } : {}),
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

function mergeCloudflareWorkersExternal(external: unknown): unknown {
  if (external === undefined) return ["cloudflare:workers"]
  if (typeof external === "string") return external === "cloudflare:workers" ? external : [external, "cloudflare:workers"]
  if (external instanceof RegExp) return [external, "cloudflare:workers"]
  if (Array.isArray(external)) {
    return external.includes("cloudflare:workers") ? external : [...external, "cloudflare:workers"]
  }
  if (typeof external === "function") {
    const externalFunction = external as RollupExternalFunction
    return (source: string, importer?: string, isResolved?: boolean) =>
      source === "cloudflare:workers" || Boolean(externalFunction(source, importer, isResolved))
  }
  return external
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

function mergeCloudflareAgentStateNitroConfig(value: unknown): NitroConfig {
  const nitro = cloneNitroConfig(value)
  configureCloudflareAgentState(nitro)
  installCloudflareAgentStateEntrypoint(nitro)
  nitro.rollupConfig ||= {}
  nitro.rollupConfig.external = mergeCloudflareWorkersExternal(nitro.rollupConfig.external)
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

function agentDevtoolsEnabled(agent: AgentModuleOptions | false | undefined): boolean {
  return agent !== false && agent?.devtools !== false
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
  const target = config as ResolvedConfig & { preset?: unknown, vitehub?: { preset?: unknown } }
  const hosting = [
    target.vitehub?.preset,
    target.preset,
    process.env.VITEHUB_HOSTING,
    process.env.NETLIFY ? "netlify" : undefined,
    process.env.NETLIFY_DEV ? "netlify" : undefined,
    process.env.NETLIFY_LOCAL ? "netlify" : undefined,
  ]
  return hosting.some(value =>
    typeof value === "string" && value.trim().toLowerCase().replaceAll("_", "-").includes("netlify"))
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
  return [
    "",
    `const viteHubChatStateOptions = ${JSON.stringify(state)}`,
    "const viteHubChatState = createLibsqlAgentState({",
    "  ...viteHubChatStateOptions,",
    "  ...(typeof process === 'object' && process?.env?.VITEHUB_AGENT_STATE_AUTH_TOKEN ? { authToken: process.env.VITEHUB_AGENT_STATE_AUTH_TOKEN } : {}),",
    "  ...(typeof process === 'object' && process?.env?.VITEHUB_AGENT_STATE_URL ? { url: process.env.VITEHUB_AGENT_STATE_URL } : {}),",
    "})",
    "",
    "function chatStateFromLibsql() {",
    "  return viteHubChatState",
    "}",
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
    imports: [`import { installHostedWorkspaceRuntime } from ${JSON.stringify(subpath(workspaceImportBase, "internal/runtime/hosted"))}`],
    setup: [
      "function hasHostedWorkspaceStore(module) {",
      "  const agent = resolveAgentModule(module)",
      "  const store = agent?.__vitehubWorkspaceAgentOptions?.workspace?.store",
      "  if (!store && typeof process === 'object' && process?.env?.BLOB_READ_WRITE_TOKEN) return true",
      "  return store && typeof store === 'object' && ['cloudflare-artifacts', 'github', 'vercel-blob'].includes(store.provider)",
      "}",
      "",
      `if ([${modules.join(", ")}].some(hasHostedWorkspaceStore)) installHostedWorkspaceRuntime()`,
      "",
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
  const runtimeRouteOption = options.runtime === "vite" ? ", runtime: 'vite'" : ""
  const imports = definitions
    .map((definition, index) => `import * as agent${index} from ${JSON.stringify(moduleImportSpecifier(handlerPath, definition.handler))}`)
    .join("\n")
  const workspaceEntries = (await Promise.all(definitions
    .map(async (definition, index) => {
      const sourceRootDir = resolveWorkspaceSourceRoot(definition.handler)
      return definition.workspace
        ? `workspaceRegistryEntry(${JSON.stringify(definition.workspace)}, agent${index}, ${JSON.stringify(sourceRootDir)}, ${JSON.stringify(await readColocatedAgentInstructions(definition.handler))}, ${JSON.stringify({ inferredName: definition.name, workspace: definition.workspace })})`
        : undefined
    })))
    .filter(Boolean)
    .join(",\n  ")
  const agentEntries = definitions
    .map(async (definition, index) => {
      const sourceRootDir = resolveWorkspaceSourceRoot(definition.handler)
      const agentExpression = `withAgentDefaults(withWorkspaceSourceRoot(resolveAgentModule(agent${index}), ${JSON.stringify(sourceRootDir)}, ${JSON.stringify(await readColocatedAgentInstructions(definition.handler))}), ${JSON.stringify({ inferredName: definition.name, workspace: definition.workspace })})`
      return `${JSON.stringify(definition.name)}: ${agentExpression}`
    })
  const resolvedAgentEntries = (await Promise.all(agentEntries))
    .join(",\n  ")
  const agentModuleEntries = definitions
    .map((definition, index) => `${JSON.stringify(definition.name)}: agent${index}`)
    .join(",\n  ")
  const hostedWorkspaceRuntime = generatedHostedWorkspaceRuntimeSetup(definitions, workspaceImportBase)
  const webhookRoute = typeof options.webhookRoute === "string" ? options.webhookRoute : ""
  const webhookSelector = webhookRoute.includes("[webhook]") ? "getRouterParam(event, 'webhook')" : "''"
  const webhookStateOption = options.cloudflareState
    ? "state: chatStateFromCloudflare(cloudflare), "
    : options.libsqlState
      ? "state: chatStateFromLibsql(), "
      : ""

  return [
    `import { withAgentDefaults, workspaceAgentOwnsWorkspaceDefinition, workspaceDefinitionFromOptions } from ${JSON.stringify(agentImportBase)}`,
    ...(options.cloudflareState ? [`import { createCloudflareAgentState } from ${JSON.stringify(subpath(agentImportBase, "cloudflare"))}`] : []),
    ...(options.libsqlState ? [`import { createLibsqlAgentState } from ${JSON.stringify(subpath(agentImportBase, "state/sqlite"))}`] : []),
    `import { createChannelChatRouteHandler, createChannelWebhookRouteHandler } from ${JSON.stringify(subpath(agentImportBase, "server/internal"))}`,
    `import { setWorkspaceRuntimeRegistry } from ${JSON.stringify(subpath(workspaceImportBase, "runtime"))}`,
    ...hostedWorkspaceRuntime.imports,
    "import { createError, defineEventHandler, getRequestHeaders, getRequestURL, getRouterParam, readRawBody } from 'h3'",
    imports,
    "",
    "function resolveAgentModule(module) {",
    "  return module && typeof module === 'object' && 'default' in module ? module.default : module",
    "}",
    "",
    "function resolveChatRouteOptions(module) {",
    "  const chatRoute = module && typeof module === 'object' ? module.chatRoute : undefined",
    "  return chatRoute && typeof chatRoute === 'object' ? chatRoute : undefined",
    "}",
    "",
    "function withWorkspaceSourceRoot(agent, sourceRootDir, colocatedInstructions) {",
    "  const options = agent?.__vitehubWorkspaceAgentOptions",
    "  const workspace = options?.workspace",
    "  if (!workspace || typeof workspace !== 'object' || 'name' in workspace) return agent",
    "  const existingSources = agent.sources && typeof agent.sources === 'object' ? agent.sources : undefined",
    "  const sources = colocatedInstructions",
    "    ? { __vitehubAgentInstructions: { content: colocatedInstructions, materialize: 'build', mount: '', workspacePath: 'AGENTS.md' }, ...workspace.sources, ...existingSources }",
    "    : { ...workspace.sources, ...existingSources }",
    "  const resolvedSources = Object.keys(sources).length ? sources : undefined",
    "  const resolvedSourceRootDir = workspace.sourceRootDir ?? agent.sourceRootDir ?? sourceRootDir",
    "  const workspaceOptions = { ...options, workspace: { ...workspace, ...(resolvedSources ? { sources: resolvedSources } : {}), sourceRootDir: resolvedSourceRootDir } }",
    "  return { ...agent, ...workspaceDefinitionFromOptions(workspaceOptions), __vitehubWorkspaceAgentOptions: workspaceOptions }",
    "}",
    "",
    "function workspaceRegistryEntry(name, module, sourceRootDir, colocatedInstructions, defaults) {",
    "  const agent = withAgentDefaults(withWorkspaceSourceRoot(resolveAgentModule(module), sourceRootDir, colocatedInstructions), defaults)",
    "  if (!workspaceAgentOwnsWorkspaceDefinition(agent)) return",
    "  return [name, async () => ({ ...module, default: agent })]",
    "}",
    "",
    ...hostedWorkspaceRuntime.setup,
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
    `setWorkspaceRuntimeRegistry(Object.fromEntries([${workspaceEntries ? `\n  ${workspaceEntries}\n` : ""}].filter(Boolean)))`,
    "",
    `const agents = {${resolvedAgentEntries ? `\n  ${resolvedAgentEntries}\n` : ""}}`,
    `const agentModules = {${agentModuleEntries ? `\n  ${agentModuleEntries}\n` : ""}}`,
    "const chatHandlers = Object.fromEntries(Object.entries(agents).map(([name, agent]) => [name, createChannelChatRouteHandler(agent, resolveChatRouteOptions(agentModules[name]))]))",
    "const webhookHandlers = Object.fromEntries(Object.entries(agents).map(([name, agent]) => [name, createChannelWebhookRouteHandler(agent)]))",
    "const agentNames = Object.keys(agents)",
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
    `  return isWebhookRoute ? await handler(await toRequest(event), webhook, { agentName: agent, cloudflare${runtimeRouteOption}, ${webhookStateOption}waitUntil: waitUntilFromEvent(event) }) : await handler(await toRequest(event), { agentName: agent, cloudflare${runtimeRouteOption}, waitUntil: waitUntilFromEvent(event) })`,
    "})",
    "",
  ].join("\n")
}

async function generateAgentNetlifyFunctionRouteHandler(
  definitions: DiscoveredAgentDefinition[],
  handlerPath: string,
  options: { chatRoute?: false | string, discordGatewayRoute?: false | string, runtime?: "vite", webhookRoute?: false | string } & AgentGeneratedImportOptions = {},
): Promise<string> {
  const agentImportBase = options.agentImportBase ?? agentPackageName
  const workspaceImportBase = options.workspaceImportBase ?? workspacePackageName
  const runtimeRouteOption = options.runtime === "vite" ? ", runtime: 'vite'" : ""
  const imports = definitions
    .map((definition, index) => `import * as agent${index} from ${JSON.stringify(moduleImportSpecifier(handlerPath, definition.handler))}`)
    .join("\n")
  const workspaceEntries = (await Promise.all(definitions
    .map(async (definition, index) => {
      const sourceRootDir = resolveWorkspaceSourceRoot(definition.handler)
      return definition.workspace
        ? `workspaceRegistryEntry(${JSON.stringify(definition.workspace)}, agent${index}, ${JSON.stringify(sourceRootDir)}, ${JSON.stringify(await readColocatedAgentInstructions(definition.handler))}, ${JSON.stringify({ inferredName: definition.name, workspace: definition.workspace })})`
        : undefined
    })))
    .filter(Boolean)
    .join(",\n  ")
  const agentEntries = (await Promise.all(definitions
    .map(async (definition, index) => {
      const sourceRootDir = resolveWorkspaceSourceRoot(definition.handler)
      const agentExpression = `withAgentDefaults(withWorkspaceSourceRoot(resolveAgentModule(agent${index}), ${JSON.stringify(sourceRootDir)}, ${JSON.stringify(await readColocatedAgentInstructions(definition.handler))}), ${JSON.stringify({ inferredName: definition.name, workspace: definition.workspace })})`
      return `${JSON.stringify(definition.name)}: ${agentExpression}`
    })))
    .join(",\n  ")
  const agentModuleEntries = definitions
    .map((definition, index) => `${JSON.stringify(definition.name)}: agent${index}`)
    .join(",\n  ")
  const hostedWorkspaceRuntime = generatedHostedWorkspaceRuntimeSetup(definitions, workspaceImportBase)
  const webhookSelector = routeUsesParam(options.webhookRoute, "webhook") ? "netlifyParam(context, 'webhook')" : "''"

  return [
    `import { withAgentDefaults, workspaceAgentOwnsWorkspaceDefinition, workspaceDefinitionFromOptions } from ${JSON.stringify(agentImportBase)}`,
    `import { createChannelChatRouteHandler, createChannelWebhookRouteHandler, createDiscordGatewayRouteHandler } from ${JSON.stringify(subpath(agentImportBase, "server/internal"))}`,
    `import { setWorkspaceRuntimeRegistry } from ${JSON.stringify(subpath(agentImportBase, "server/workspace"))}`,
    ...hostedWorkspaceRuntime.imports,
    imports,
    "",
    "function resolveAgentModule(module) {",
    "  return module && typeof module === 'object' && 'default' in module ? module.default : module",
    "}",
    "",
    "function resolveChatRouteOptions(module) {",
    "  const chatRoute = module && typeof module === 'object' ? module.chatRoute : undefined",
    "  return chatRoute && typeof chatRoute === 'object' ? chatRoute : undefined",
    "}",
    "",
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
    "function withWorkspaceSourceRoot(agent, sourceRootDir, colocatedInstructions) {",
    "  const options = agent?.__vitehubWorkspaceAgentOptions",
    "  const workspace = options?.workspace",
    "  if (!workspace || typeof workspace !== 'object' || 'name' in workspace) return agent",
    "  const existingSources = agent.sources && typeof agent.sources === 'object' ? agent.sources : undefined",
    "  const sources = colocatedInstructions",
    "    ? { __vitehubAgentInstructions: { content: colocatedInstructions, materialize: 'build', mount: '', workspacePath: 'AGENTS.md' }, ...workspace.sources, ...existingSources }",
    "    : { ...workspace.sources, ...existingSources }",
    "  const resolvedSources = Object.keys(sources).length ? sources : undefined",
    "  const resolvedSourceRootDir = workspace.sourceRootDir ?? agent.sourceRootDir ?? sourceRootDir",
    "  const workspaceOptions = { ...options, workspace: { ...workspace, ...(resolvedSources ? { sources: resolvedSources } : {}), sourceRootDir: resolvedSourceRootDir } }",
    "  return { ...agent, ...workspaceDefinitionFromOptions(workspaceOptions), __vitehubWorkspaceAgentOptions: workspaceOptions }",
    "}",
    "",
    "function workspaceRegistryEntry(name, module, sourceRootDir, colocatedInstructions, defaults) {",
    "  const agent = withAgentDefaults(withWorkspaceSourceRoot(resolveAgentModule(module), sourceRootDir, colocatedInstructions), defaults)",
    "  if (!workspaceAgentOwnsWorkspaceDefinition(agent)) return",
    "  return [name, async () => ({ ...module, default: agent })]",
    "}",
    "",
    ...hostedWorkspaceRuntime.setup,
    ...generatedNetlifyRuntimeHelpers(),
    "",
    `setWorkspaceRuntimeRegistry(Object.fromEntries([${workspaceEntries ? `\n  ${workspaceEntries}\n` : ""}].filter(Boolean)))`,
    "",
    `const agents = {${agentEntries ? `\n  ${agentEntries}\n` : ""}}`,
    `const agentModules = {${agentModuleEntries ? `\n  ${agentModuleEntries}\n` : ""}}`,
    "const chatHandlers = Object.fromEntries(Object.entries(agents).map(([name, agent]) => [name, createChannelChatRouteHandler(agent, resolveChatRouteOptions(agentModules[name]))]))",
    "const webhookHandlers = Object.fromEntries(Object.entries(agents).map(([name, agent]) => [name, createChannelWebhookRouteHandler(agent)]))",
    "const discordGatewayHandlers = Object.fromEntries(Object.entries(agents).map(([name, agent]) => [name, createDiscordGatewayRouteHandler(agent)]))",
    "const agentNames = Object.keys(agents)",
    `const webhookRoute = ${JSON.stringify(generatedWebhookRoute(options.webhookRoute))}`,
    `const defaultDiscordGatewayDurationMs = ${JSON.stringify(9 * 60 * 1000)}`,
    `const chatRoutePattern = new RegExp(${JSON.stringify(routeRegexSource(options.chatRoute))})`,
    `const webhookRoutePattern = new RegExp(${JSON.stringify(routeRegexSource(options.webhookRoute))})`,
    `const discordGatewayRoutePattern = new RegExp(${JSON.stringify(routeRegexSource(options.discordGatewayRoute))})`,
    "",
    "export default async function viteHubAgentNetlifyFunction(request, context) {",
    "  ensureNetlifyHostingEnv()",
    "  const pathname = new URL(request.url).pathname",
    "  const isDiscordGatewayRoute = discordGatewayRoutePattern.test(pathname)",
    "  const isWebhookRoute = webhookRoutePattern.test(pathname)",
    "  const agent = netlifyParam(context, 'agent') || (agentNames.length === 1 ? agentNames[0] : undefined)",
    `  const webhook = ${webhookSelector}`,
    "  const handler = agent ? (isDiscordGatewayRoute ? discordGatewayHandlers[agent] : isWebhookRoute ? webhookHandlers[agent] : chatHandlers[agent]) : undefined",
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
    `    return await handler(request, { agentName: agent, durationMs${runtimeRouteOption}, waitUntil, webhookUrl })`,
    "  }",
    `  return isWebhookRoute ? await handler(request, webhook, { agentName: agent${runtimeRouteOption}, waitUntil }) : await handler(request, { agentName: agent${runtimeRouteOption}, waitUntil })`,
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
  const runtimeRouteOption = options.runtime === "vite" ? ", runtime: 'vite'" : ""
  const imports = definitions
    .map((definition, index) => `import * as agent${index} from ${JSON.stringify(moduleImportSpecifier(handlerPath, definition.handler))}`)
    .join("\n")
  const agentEntries = (await Promise.all(definitions
    .map(async (definition, index) => {
      const sourceRootDir = resolveWorkspaceSourceRoot(definition.handler)
      const agentExpression = `withAgentDefaults(withWorkspaceSourceRoot(resolveAgentModule(agent${index}), ${JSON.stringify(sourceRootDir)}, ${JSON.stringify(await readColocatedAgentInstructions(definition.handler))}), ${JSON.stringify({ inferredName: definition.name, workspace: definition.workspace })})`
      return `${JSON.stringify(definition.name)}: ${agentExpression}`
    })))
    .join(",\n  ")
  const agentNames = definitions.map(definition => definition.name)

  return [
    `import { withAgentDefaults, workspaceDefinitionFromOptions } from ${JSON.stringify(agentImportBase)}`,
    `import { createDiscordGatewayRouteHandler } from ${JSON.stringify(subpath(agentImportBase, "server/internal"))}`,
    "import { createError, defineEventHandler, getRequestHeader, getRequestHeaders, getRequestURL, getRouterParam } from 'h3'",
    imports,
    "",
    "function resolveAgentModule(module) {",
    "  return module && typeof module === 'object' && 'default' in module ? module.default : module",
    "}",
    "",
    "function withWorkspaceSourceRoot(agent, sourceRootDir, colocatedInstructions) {",
    "  const options = agent?.__vitehubWorkspaceAgentOptions",
    "  const workspace = options?.workspace",
    "  if (!workspace || typeof workspace !== 'object' || 'name' in workspace) return agent",
    "  const existingSources = agent.sources && typeof agent.sources === 'object' ? agent.sources : undefined",
    "  const sources = colocatedInstructions",
    "    ? { __vitehubAgentInstructions: { content: colocatedInstructions, materialize: 'build', mount: '', workspacePath: 'AGENTS.md' }, ...workspace.sources, ...existingSources }",
    "    : { ...workspace.sources, ...existingSources }",
    "  const resolvedSources = Object.keys(sources).length ? sources : undefined",
    "  const resolvedSourceRootDir = workspace.sourceRootDir ?? agent.sourceRootDir ?? sourceRootDir",
    "  const workspaceOptions = { ...options, workspace: { ...workspace, ...(resolvedSources ? { sources: resolvedSources } : {}), sourceRootDir: resolvedSourceRootDir } }",
    "  return { ...agent, ...workspaceDefinitionFromOptions(workspaceOptions), __vitehubWorkspaceAgentOptions: workspaceOptions }",
    "}",
    "",
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
    `const webhookRoute = ${JSON.stringify(generatedWebhookRoute(options.webhookRoute))}`,
    `const defaultDurationMs = ${JSON.stringify(9 * 60 * 1000)}`,
    `const agents = {${agentEntries ? `\n  ${agentEntries}\n` : ""}}`,
    `const agentNames = ${JSON.stringify(agentNames)}`,
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
    `  return await handler(new Request(requestUrl, { method: event.method || 'GET', headers: getRequestHeaders(event) }), { agentName: agent, cloudflare, durationMs${runtimeRouteOption}, waitUntil: waitUntilFromEvent(event), webhookUrl })`,
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
  options: { chatRoute?: false | string, webhookRoute?: false | string } & AgentGeneratedImportOptions = {},
): Promise<string> {
  const agentImportBase = options.agentImportBase ?? agentPackageName
  const workspaceImportBase = options.workspaceImportBase ?? workspacePackageName
  const imports = definitions
    .map((definition, index) => `import * as agent${index} from ${JSON.stringify(moduleImportSpecifier(handlerPath, definition.handler))}`)
    .join("\n")
  const workspaceEntries = (await Promise.all(definitions
    .map(async (definition, index) => {
      const sourceRootDir = resolveWorkspaceSourceRoot(definition.handler)
      return definition.workspace
        ? `workspaceRegistryEntry(${JSON.stringify(definition.workspace)}, agent${index}, ${JSON.stringify(sourceRootDir)}, ${JSON.stringify(await readColocatedAgentInstructions(definition.handler))}, ${JSON.stringify({ inferredName: definition.name, workspace: definition.workspace })})`
        : undefined
    })))
    .filter(Boolean)
    .join(",\n  ")
  const agentEntries = (await Promise.all(definitions
    .map(async (definition, index) => {
      const sourceRootDir = resolveWorkspaceSourceRoot(definition.handler)
      const agentExpression = `withAgentDefaults(withWorkspaceSourceRoot(resolveAgentModule(agent${index}), ${JSON.stringify(sourceRootDir)}, ${JSON.stringify(await readColocatedAgentInstructions(definition.handler))}), ${JSON.stringify({ inferredName: definition.name, workspace: definition.workspace })})`
      return `${JSON.stringify(definition.name)}: ${agentExpression}`
    })))
    .join(",\n  ")
  const agentModuleEntries = definitions
    .map((definition, index) => `${JSON.stringify(definition.name)}: agent${index}`)
    .join(",\n  ")
  const hostedWorkspaceRuntime = generatedHostedWorkspaceRuntimeSetup(definitions, workspaceImportBase)
  const workspaceRuntimeImports = workspaceEntries
    ? [`import { setWorkspaceRuntimeRegistry } from ${JSON.stringify(subpath(workspaceImportBase, "runtime"))}`, ...hostedWorkspaceRuntime.imports]
    : []
  const workspaceRuntimeSetup = workspaceEntries
    ? [...hostedWorkspaceRuntime.setup, `setWorkspaceRuntimeRegistry(Object.fromEntries([\n  ${workspaceEntries}\n].filter(Boolean)))`, ""]
    : []

  return [
    `import { withAgentDefaults, workspaceAgentOwnsWorkspaceDefinition, workspaceDefinitionFromOptions } from ${JSON.stringify(agentImportBase)}`,
    `import { createChannelChatRouteHandler, createChannelWebhookRouteHandler } from ${JSON.stringify(subpath(agentImportBase, "server/internal"))}`,
    ...workspaceRuntimeImports,
    imports,
    "",
    "await import('../schedule/deno-cron.mjs').catch((error) => {",
    "  if (error instanceof TypeError && String(error.message).includes('deno-cron.mjs')) return",
    "  throw error",
    "})",
    "",
    "function resolveAgentModule(module) {",
    "  return module && typeof module === 'object' && 'default' in module ? module.default : module",
    "}",
    "",
    "function resolveChatRouteOptions(module) {",
    "  const chatRoute = module && typeof module === 'object' ? module.chatRoute : undefined",
    "  return chatRoute && typeof chatRoute === 'object' ? chatRoute : undefined",
    "}",
    "",
    "function withWorkspaceSourceRoot(agent, sourceRootDir, colocatedInstructions) {",
    "  const options = agent?.__vitehubWorkspaceAgentOptions",
    "  const workspace = options?.workspace",
    "  if (!workspace || typeof workspace !== 'object' || 'name' in workspace) return agent",
    "  const existingSources = agent.sources && typeof agent.sources === 'object' ? agent.sources : undefined",
    "  const sources = colocatedInstructions",
    "    ? { __vitehubAgentInstructions: { content: colocatedInstructions, materialize: 'build', mount: '', workspacePath: 'AGENTS.md' }, ...workspace.sources, ...existingSources }",
    "    : { ...workspace.sources, ...existingSources }",
    "  const resolvedSources = Object.keys(sources).length ? sources : undefined",
    "  const resolvedSourceRootDir = workspace.sourceRootDir ?? agent.sourceRootDir ?? sourceRootDir",
    "  const workspaceOptions = { ...options, workspace: { ...workspace, ...(resolvedSources ? { sources: resolvedSources } : {}), sourceRootDir: resolvedSourceRootDir } }",
    "  return { ...agent, ...workspaceDefinitionFromOptions(workspaceOptions), __vitehubWorkspaceAgentOptions: workspaceOptions }",
    "}",
    "",
    "function workspaceRegistryEntry(name, module, sourceRootDir, colocatedInstructions, defaults) {",
    "  const agent = withAgentDefaults(withWorkspaceSourceRoot(resolveAgentModule(module), sourceRootDir, colocatedInstructions), defaults)",
    "  if (!workspaceAgentOwnsWorkspaceDefinition(agent)) return",
    "  return [name, async () => ({ ...module, default: agent })]",
    "}",
    "",
    ...workspaceRuntimeSetup,
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
    `const agents = {${agentEntries ? `\n  ${agentEntries}\n` : ""}}`,
    `const agentModules = {${agentModuleEntries ? `\n  ${agentModuleEntries}\n` : ""}}`,
    "const chatHandlers = Object.fromEntries(Object.entries(agents).map(([name, agent]) => [name, createChannelChatRouteHandler(agent, resolveChatRouteOptions(agentModules[name]))]))",
    "const webhookHandlers = Object.fromEntries(Object.entries(agents).map(([name, agent]) => [name, createChannelWebhookRouteHandler(agent)]))",
    "const agentNames = Object.keys(agents)",
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
    "  return isWebhookRoute ? await handler(request, webhook, { agentName: agent }) : await handler(request, { agentName: agent })",
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
  options: { chatRoute?: false | string, webhookRoute?: false | string } & AgentGeneratedImportOptions = {},
): Promise<void> {
  const handlerPath = join(root, generatedAgentDenoServer)
  const definitions = discoverAgentDefinitions({
    mode: "server-agents",
    scanDirs: [join(root, "server")],
  })
  await mkdir(dirname(handlerPath), { recursive: true })
  await writeFile(handlerPath, await generateAgentDenoServer(definitions, handlerPath, options), "utf8")
}

async function writeAgentNetlifyFunctionRouteHandler(
  root: string,
  options: { chatRoute?: false | string, discordGatewayRoute?: false | string, runtime?: "vite", webhookRoute?: false | string } & AgentGeneratedImportOptions = {},
): Promise<string> {
  const handlerPath = join(root, generatedAgentNetlifyFunction)
  const definitions = discoverAgentDefinitions({
    mode: "server-agents",
    scanDirs: [join(root, "server")],
  })
  await mkdir(dirname(handlerPath), { recursive: true })
  await writeFile(handlerPath, await generateAgentNetlifyFunctionRouteHandler(definitions, handlerPath, options), "utf8")
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

async function writeNetlifyAgentProviderOutput(config: ResolvedConfig, options: ResolvedAgentModuleOptions, generatedOptions: AgentGeneratedImportOptions & { runtime?: "vite" } = {}): Promise<void> {
  const handlerPath = await writeAgentNetlifyFunctionRouteHandler(config.root, {
    ...generatedOptions,
    chatRoute: options.routes.chat,
    discordGatewayRoute: options.routes.discordGateway,
    webhookRoute: options.routes.webhooks,
  })
  await writeProviderDeploymentOutputs({
    clientOutDir: config.build?.outDir ?? "dist",
    netlify: {
      functions: [{
        bundleEntry: handlerPath,
        bundleOptions: {
          alias: resolveStringAliases(config),
          external: optionalNetlifyAgentBundleExternals,
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
  let agent: AgentModuleOptions | false | undefined = options
  let resolved: ResolvedConfig | undefined

  return {
    name: "@vite-hub/agent/vite",
    devtools: {
      setup(ctx) {
        if (agentDevtoolsEnabled(agent)) {
          return chatDevTools().devtools?.setup?.(ctx)
        }
      },
    },
    async configureServer(server) {
      if (agentDevtoolsEnabled(agent)) {
        registerChatDevtoolsBridge(server)
      }
      if (agent !== false) {
        await registerAgentInvocationStreamEndpoint(server)
      }
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
      const denoOutput = resolved && resolved.runtime === "deno"
      const installCloudflareState = !denoOutput && shouldInstallCloudflareAgentState(resolved)
      const nitroHandlers = [
        ...(resolved && !denoOutput && resolved.routes.chat
          ? [{
              handler: generatedAgentWebhookRouteHandler,
              route: normalizeNitroRoute(resolved.routes.chat),
            }]
          : []),
        ...(resolved && !denoOutput && resolved.routes.webhooks
          ? [{
              handler: generatedAgentWebhookRouteHandler,
              route: normalizeNitroRoute(resolved.routes.webhooks),
            }]
          : []),
        ...(resolved && !denoOutput && resolved.routes.discordGateway
          ? [{
              handler: generatedAgentDiscordGatewayRouteHandler,
              route: normalizeNitroRoute(resolved.routes.discordGateway),
            }]
          : []),
      ]
      const nitro = installCloudflareState
        ? mergeCloudflareAgentStateNitroConfig((config as { nitro?: unknown }).nitro)
        : cloneNitroConfig((config as { nitro?: unknown }).nitro)
      const mergedNitro = mergeNitroHandlers(nitro, nitroHandlers)
      return {
        ...(typeof agent !== "undefined" ? { agent } : {}),
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
      const normalized = normalizeAgentOptions(agent)
      if (normalized && (normalized.routes.chat || normalized.routes.webhooks || normalized.routes.discordGateway)) {
        if (normalized.runtime === "deno") {
          if (normalized.routes.chat || normalized.routes.webhooks) {
            await writeAgentDenoServer(config.root, {
              agentImportBase: getAgentImportBase(agent),
              chatRoute: normalized.routes.chat,
              workspaceImportBase: getWorkspaceImportBase(agent),
              webhookRoute: normalized.routes.webhooks,
            })
          }
        }
        else {
          if (normalized.routes.chat || normalized.routes.webhooks) {
            await writeAgentWebhookRouteHandler(config.root, {
              agentImportBase: getAgentImportBase(agent),
              chatRoute: normalized.routes.chat,
              cloudflareState: shouldInstallCloudflareAgentState(normalized),
              libsqlState: resolveLibsqlAgentState(normalized),
              ...(config.command === "serve" ? { runtime: "vite" as const } : {}),
              workspaceImportBase: getWorkspaceImportBase(agent),
              webhookRoute: normalized.routes.webhooks,
            })
          }
          if (normalized.routes.discordGateway) {
            await writeAgentDiscordGatewayRouteHandler(config.root, {
              agentImportBase: getAgentImportBase(agent),
              discordGatewayRoute: normalized.routes.discordGateway,
              ...(config.command === "serve" ? { runtime: "vite" as const } : {}),
              workspaceImportBase: getWorkspaceImportBase(agent),
              webhookRoute: normalized.routes.webhooks,
            })
          }
          if (config.command === "serve" && isNetlifyHosting(config)) {
            await writeNetlifyAgentProviderOutput(config, normalized, {
              agentImportBase: getAgentImportBase(agent),
              runtime: "vite",
              workspaceImportBase: getWorkspaceImportBase(agent),
            })
          }
        }
      } else if (config.command === "serve" && isNetlifyHosting(config)) {
        await cleanupNetlifyAgentProviderOutput(config)
      }
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
        if (normalized && isNetlifyHosting(resolved) && (normalized.routes.chat || normalized.routes.webhooks || normalized.routes.discordGateway)) {
          await writeNetlifyAgentProviderOutput(resolved, normalized, {
            agentImportBase: getAgentImportBase(agent),
            workspaceImportBase: getWorkspaceImportBase(agent),
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
