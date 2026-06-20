import { existsSync, statSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join, relative } from "node:path"

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
import { resolveAgentEvalOptions, writeAgentEvaliteConfig } from "./internal/evalite-config.ts"

import type { Plugin, ResolvedConfig } from "vite"
import type { CloudflareAgentStateMigration, CloudflareAgentStateRollupTarget, CloudflareAgentStateTarget } from "./cloudflare.ts"
import type { ChatDevToolsOptions } from "./chat/devtools.ts"
import type { AgentModuleOptions, DiscoveredAgentDefinition, ResolvedAgentModuleOptions } from "./types.ts"

interface AgentCliContributingPlugin {
  vitehub?: {
    cli?: unknown
  }
}

export type AgentVitePlugin = Plugin & AgentCliContributingPlugin

const agentPackageName = "@vite-hub/agent"
const mergeNoExternal = createNoExternalMerger(agentPackageName)
const generatedAgentWebhookRouteHandler = ".vitehub/agent/chat-webhook-route.ts"
const generatedAgentNetlifyFunction = ".vitehub/agent/netlify-function.mjs"
const netlifyAgentFunctionName = "vitehub-agent"

type NitroConfig = Record<string, unknown> & CloudflareAgentStateRollupTarget & CloudflareAgentStateTarget
type RollupExternalFunction = (source: string, importer?: string, isResolved?: boolean) => boolean | null | undefined | void

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function shouldInstallCloudflareAgentState(options: false | ResolvedAgentModuleOptions): options is ResolvedAgentModuleOptions {
  if (!options || !options.routes.webhooks) return false
  const provider = options.providers.state.provider
  return provider === "auto" || provider === "cloudflare" || provider === "cloudflare-agents"
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

function agentDevtoolsMeta(agent: AgentModuleOptions | false | undefined): ChatDevToolsOptions["meta"] {
  return agent && isRecord(agent.devtools) && isRecord(agent.devtools.meta) && !Array.isArray(agent.devtools.meta)
    ? { ...agent.devtools.meta }
    : undefined
}

function normalizeNitroRoute(route: string): string {
  const normalized = route.startsWith("/") ? route : `/${route}`
  return normalized.replace(/\[([^\]]+)\]/g, ":$1")
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function routeRegexSource(route: false | string | undefined): string {
  if (!route) return "(?!)"
  return `^${normalizeNitroRoute(route).split("/").map(part => part.startsWith(":") ? "[^/]+" : escapeRegExp(part)).join("/")}$`
}

function routeUsesParam(route: false | string | undefined, param: string): boolean {
  return Boolean(route && normalizeNitroRoute(route).split("/").includes(`:${param}`))
}

function isNetlifyHosting(config: ResolvedConfig): boolean {
  const target = config as ResolvedConfig & { preset?: unknown, vitehub?: { preset?: unknown } }
  const hosting = [
    target.vitehub?.preset,
    target.preset,
    process.env.VITEHUB_HOSTING,
    process.env.NETLIFY ? "netlify" : undefined,
  ]
  return hosting.some(value =>
    typeof value === "string" && value.trim().toLowerCase().replaceAll("_", "-").includes("netlify"))
}

function resolveWorkspaceSourceRoot(file: string): string {
  const workspaceDirectory = join(dirname(file), "workspace")
  return existsSync(workspaceDirectory) && statSync(workspaceDirectory).isDirectory()
    ? workspaceDirectory
    : dirname(file)
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

function generateAgentWebhookRouteHandler(
  definitions: DiscoveredAgentDefinition[],
  handlerPath: string,
  options: { chatRoute?: false | string, cloudflareState?: boolean, webhookRoute?: false | string } = {},
): string {
  const imports = definitions
    .map((definition, index) => `import * as agent${index} from ${JSON.stringify(moduleImportSpecifier(handlerPath, definition.handler))}`)
    .join("\n")
  const workspaceEntries = definitions
    .map((definition, index) => definition.workspace
      ? `${JSON.stringify(definition.workspace)}: async () => ({ ...agent${index}, default: { ...agent${index}.default, sourceRootDir: agent${index}.default?.sourceRootDir ?? ${JSON.stringify(resolveWorkspaceSourceRoot(definition.handler))} } })`
      : undefined)
    .filter(Boolean)
    .join(",\n  ")
  const agentEntries = definitions
    .map((definition, index) => {
      const agentExpression = `withAgentDefaults(resolveAgentModule(agent${index}), ${JSON.stringify({ inferredName: definition.name, workspace: definition.workspace })})`
      return `${JSON.stringify(definition.name)}: ${agentExpression}`
    })
    .join(",\n  ")
  const agentModuleEntries = definitions
    .map((definition, index) => `${JSON.stringify(definition.name)}: agent${index}`)
    .join(",\n  ")
  const webhookRoute = typeof options.webhookRoute === "string" ? options.webhookRoute : ""
  const webhookSelector = webhookRoute.includes("[webhook]") ? "getRouterParam(event, 'webhook')" : "''"

  return [
    "import { withAgentDefaults } from '@vite-hub/agent'",
    ...(options.cloudflareState ? ["import { createCloudflareAgentState } from '@vite-hub/agent/cloudflare'"] : []),
    "import { defineAgentChatFetchHandler, defineAgentChatWebhookFetchHandler } from '@vite-hub/agent/server'",
    "import { setWorkspaceRuntimeRegistry } from '@vite-hub/workspace/internal/runtime/state'",
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
    "async function toRequest(event) {",
    "  if (event.request instanceof Request) {",
    "    return event.request",
    "  }",
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
    "",
    `setWorkspaceRuntimeRegistry({${workspaceEntries ? `\n  ${workspaceEntries}\n` : ""}})`,
    "",
    `const agents = {${agentEntries ? `\n  ${agentEntries}\n` : ""}}`,
    `const agentModules = {${agentModuleEntries ? `\n  ${agentModuleEntries}\n` : ""}}`,
    "const chatHandlers = Object.fromEntries(Object.entries(agents).map(([name, agent]) => [name, defineAgentChatFetchHandler(agent, resolveChatRouteOptions(agentModules[name]))]))",
    "const webhookHandlers = Object.fromEntries(Object.entries(agents).map(([name, agent]) => [name, defineAgentChatWebhookFetchHandler(agent)]))",
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
    options.cloudflareState
      ? "  return isWebhookRoute ? await handler(await toRequest(event), webhook, { agentName: agent, cloudflare, state: chatStateFromCloudflare(cloudflare), waitUntil: waitUntilFromEvent(event) }) : await handler(await toRequest(event), { agentName: agent, cloudflare, waitUntil: waitUntilFromEvent(event) })"
      : "  return isWebhookRoute ? await handler(await toRequest(event), webhook, { agentName: agent, cloudflare, waitUntil: waitUntilFromEvent(event) }) : await handler(await toRequest(event), { agentName: agent, cloudflare, waitUntil: waitUntilFromEvent(event) })",
    "})",
    "",
  ].join("\n")
}

function generateAgentNetlifyFunctionRouteHandler(
  definitions: DiscoveredAgentDefinition[],
  handlerPath: string,
  options: { chatRoute?: false | string, webhookRoute?: false | string } = {},
): string {
  const imports = definitions
    .map((definition, index) => `import * as agent${index} from ${JSON.stringify(moduleImportSpecifier(handlerPath, definition.handler))}`)
    .join("\n")
  const workspaceEntries = definitions
    .map((definition, index) => definition.workspace
      ? `${JSON.stringify(definition.workspace)}: async () => ({ ...agent${index}, default: { ...agent${index}.default, sourceRootDir: agent${index}.default?.sourceRootDir ?? ${JSON.stringify(resolveWorkspaceSourceRoot(definition.handler))} } })`
      : undefined)
    .filter(Boolean)
    .join(",\n  ")
  const agentEntries = definitions
    .map((definition, index) => {
      const agentExpression = `withAgentDefaults(resolveAgentModule(agent${index}), ${JSON.stringify({ inferredName: definition.name, workspace: definition.workspace })})`
      return `${JSON.stringify(definition.name)}: ${agentExpression}`
    })
    .join(",\n  ")
  const agentModuleEntries = definitions
    .map((definition, index) => `${JSON.stringify(definition.name)}: agent${index}`)
    .join(",\n  ")
  const webhookSelector = routeUsesParam(options.webhookRoute, "webhook") ? "netlifyParam(context, 'webhook')" : "''"

  return [
    "import { withAgentDefaults } from '@vite-hub/agent'",
    "import { defineAgentChatFetchHandler, defineAgentChatWebhookFetchHandler } from '@vite-hub/agent/server'",
    "import { setWorkspaceRuntimeRegistry } from '@vite-hub/workspace/internal/runtime/state'",
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
    ...generatedNetlifyRuntimeHelpers(),
    "",
    `setWorkspaceRuntimeRegistry({${workspaceEntries ? `\n  ${workspaceEntries}\n` : ""}})`,
    "",
    `const agents = {${agentEntries ? `\n  ${agentEntries}\n` : ""}}`,
    `const agentModules = {${agentModuleEntries ? `\n  ${agentModuleEntries}\n` : ""}}`,
    "const chatHandlers = Object.fromEntries(Object.entries(agents).map(([name, agent]) => [name, defineAgentChatFetchHandler(agent, resolveChatRouteOptions(agentModules[name]))]))",
    "const webhookHandlers = Object.fromEntries(Object.entries(agents).map(([name, agent]) => [name, defineAgentChatWebhookFetchHandler(agent)]))",
    "const agentNames = Object.keys(agents)",
    `const chatRoutePattern = new RegExp(${JSON.stringify(routeRegexSource(options.chatRoute))})`,
    `const webhookRoutePattern = new RegExp(${JSON.stringify(routeRegexSource(options.webhookRoute))})`,
    "",
    "export default async function viteHubAgentNetlifyFunction(request, context) {",
    "  ensureNetlifyHostingEnv()",
    "  const pathname = new URL(request.url).pathname",
    "  const isWebhookRoute = webhookRoutePattern.test(pathname)",
    "  const agent = netlifyParam(context, 'agent') || (agentNames.length === 1 ? agentNames[0] : undefined)",
    `  const webhook = ${webhookSelector}`,
    "  const handler = agent ? (isWebhookRoute ? webhookHandlers[agent] : chatHandlers[agent]) : undefined",
    "  if (!handler) {",
    "    return Response.json({ message: 'Unknown ViteHub agent.', status: 404 }, { status: 404 })",
    "  }",
    "  const waitUntil = waitUntilFromContext(context)",
    "  return isWebhookRoute ? await handler(request, webhook, { agentName: agent, waitUntil }) : await handler(request, { agentName: agent, waitUntil })",
    "}",
    "",
  ].join("\n")
}

async function writeAgentWebhookRouteHandler(
  root: string,
  options: { chatRoute?: false | string, cloudflareState?: boolean, webhookRoute?: false | string } = {},
): Promise<void> {
  const handlerPath = join(root, generatedAgentWebhookRouteHandler)
  const definitions = discoverAgentDefinitions({
    mode: "server-agents",
    scanDirs: [join(root, "server")],
  })
  await mkdir(dirname(handlerPath), { recursive: true })
  await writeFile(handlerPath, generateAgentWebhookRouteHandler(definitions, handlerPath, options), "utf8")
}

async function writeAgentNetlifyFunctionRouteHandler(
  root: string,
  options: { chatRoute?: false | string, webhookRoute?: false | string } = {},
): Promise<string> {
  const handlerPath = join(root, generatedAgentNetlifyFunction)
  const definitions = discoverAgentDefinitions({
    mode: "server-agents",
    scanDirs: [join(root, "server")],
  })
  await mkdir(dirname(handlerPath), { recursive: true })
  await writeFile(handlerPath, generateAgentNetlifyFunctionRouteHandler(definitions, handlerPath, options), "utf8")
  return handlerPath
}

function createNetlifyAgentFunctionConfig(options: { chatRoute?: false | string, webhookRoute?: false | string }): object {
  const paths = [
    options.chatRoute ? normalizeNitroRoute(options.chatRoute) : undefined,
    options.webhookRoute ? normalizeNitroRoute(options.webhookRoute) : undefined,
  ].filter((path): path is string => Boolean(path))

  return {
    path: paths.length === 1 ? paths[0] : paths,
    name: netlifyAgentFunctionName,
    nodeBundler: "esbuild",
  }
}

export function hubAgent(options?: AgentModuleOptions): AgentVitePlugin {
  let agent: AgentModuleOptions | false | undefined = options
  let resolved: ResolvedConfig | undefined

  return {
    name: "@vite-hub/agent/vite",
    devtools: {
      setup(ctx) {
        if (agentDevtoolsEnabled(agent)) {
          return chatDevTools({ meta: agentDevtoolsMeta(agent) }).devtools?.setup?.(ctx)
        }
      },
    },
    configureServer(server) {
      if (agentDevtoolsEnabled(agent)) {
        registerChatDevtoolsBridge(server, { meta: agentDevtoolsMeta(agent) })
      }
      if (agent !== false) {
        registerAgentInvocationStreamEndpoint(server)
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
      const installCloudflareState = shouldInstallCloudflareAgentState(resolved)
      const nitroHandlers = [
        ...(resolved && resolved.routes.chat
          ? [{
              handler: generatedAgentWebhookRouteHandler,
              route: normalizeNitroRoute(resolved.routes.chat),
            }]
          : []),
        ...(resolved && resolved.routes.webhooks
          ? [{
              handler: generatedAgentWebhookRouteHandler,
              route: normalizeNitroRoute(resolved.routes.webhooks),
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
      if (normalized && (normalized.routes.chat || normalized.routes.webhooks)) {
        await writeAgentWebhookRouteHandler(config.root, {
          chatRoute: normalized.routes.chat,
          cloudflareState: shouldInstallCloudflareAgentState(normalized),
          webhookRoute: normalized.routes.webhooks,
        })
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
        if (normalized && isNetlifyHosting(resolved) && (normalized.routes.chat || normalized.routes.webhooks)) {
          const handlerPath = await writeAgentNetlifyFunctionRouteHandler(resolved.root, {
            chatRoute: normalized.routes.chat,
            webhookRoute: normalized.routes.webhooks,
          })
          await writeProviderDeploymentOutputs({
            clientOutDir: resolved.build?.outDir ?? "dist",
            netlify: {
              functions: [{
                bundleEntry: handlerPath,
                bundleOptions: {
                  format: "esm",
                  platform: "node",
                },
                config: createNetlifyAgentFunctionConfig({
                  chatRoute: normalized.routes.chat,
                  webhookRoute: normalized.routes.webhooks,
                }),
                functionName: netlifyAgentFunctionName,
              }],
            },
            rootDir: resolved.root,
          })
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
