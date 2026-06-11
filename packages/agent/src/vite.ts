import { existsSync, statSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join, relative } from "node:path"

import { copyVercelFunctionRuntimePackages } from "@vite-hub/internal/build/vercel-runtime-packages"
import { createNoExternalMerger, isServerEnvironment, mergeGeneratedViteHubWatchIgnored } from "@vite-hub/internal/build/vite"

import { chatDevTools } from "./chat/devtools.ts"
import { registerChatDevtoolsBridge } from "./chat/vite/devtools-bridge.ts"
import { normalizeAgentOptions } from "./config.ts"
import { discoverAgentDefinitions } from "./discovery.ts"
import { resolveAgentEvalOptions, writeAgentEvaliteConfig } from "./internal/evalite-config.ts"

import type { Plugin, ResolvedConfig } from "vite"
import type { AgentModuleOptions, DiscoveredAgentDefinition } from "./types.ts"

interface AgentCliContributingPlugin {
  vitehub?: {
    cli?: unknown
  }
}

export type AgentVitePlugin = Plugin & AgentCliContributingPlugin

const agentPackageName = "@vite-hub/agent"
const mergeNoExternal = createNoExternalMerger(agentPackageName)
const generatedAgentRouteHandler = ".vitehub/agent/chat-route.ts"
const generatedAgentWebhookRouteHandler = ".vitehub/agent/chat-webhook-route.ts"

function agentDevtoolsEnabled(agent: AgentModuleOptions | false | undefined): boolean {
  return agent !== false && agent?.devtools !== false
}

function normalizeNitroRoute(route: string): string {
  const normalized = route.startsWith("/") ? route : `/${route}`
  return normalized.replace(/\[([^\]]+)\]/g, ":$1")
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

function generateAgentRouteHandler(definitions: DiscoveredAgentDefinition[], handlerPath: string): string {
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
      const agentExpression = definition.workspace
        ? `withWorkspaceAgentDefaults(resolveAgentModule(agent${index}), ${JSON.stringify({ name: definition.name, workspace: definition.workspace })})`
        : `resolveAgentModule(agent${index})`
      return `${JSON.stringify(definition.name)}: ${agentExpression}`
    })
    .join(",\n  ")

  return [
    "import { withWorkspaceAgentDefaults } from '@vite-hub/agent'",
    "import { defineAgentChatFetchHandler } from '@vite-hub/agent/server'",
    "import { setWorkspaceRuntimeRegistry } from '@vite-hub/workspace/internal/runtime/state'",
    "import { createError, defineEventHandler, getRequestHeaders, getRequestURL, getRouterParam, readRawBody } from 'h3'",
    imports,
    "",
    "function resolveAgentModule(module) {",
    "  return module && typeof module === 'object' && 'default' in module ? module.default : module",
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
    "function waitUntilFromEvent(event) {",
    "  return typeof event.waitUntil === 'function' ? event.waitUntil.bind(event) : undefined",
    "}",
    "",
    `setWorkspaceRuntimeRegistry({${workspaceEntries ? `\n  ${workspaceEntries}\n` : ""}})`,
    "",
    `const agents = {${agentEntries ? `\n  ${agentEntries}\n` : ""}}`,
    "const handlers = Object.fromEntries(Object.entries(agents).map(([name, agent]) => [name, defineAgentChatFetchHandler(agent)]))",
    "",
    "export default defineEventHandler(async (event) => {",
    "  const agent = getRouterParam(event, 'agent')",
    "  const handler = agent ? handlers[agent] : undefined",
    "  if (!handler) {",
    "    throw createError({ statusCode: 404, statusMessage: 'Unknown ViteHub agent.' })",
    "  }",
    "  return await handler(await toRequest(event), { waitUntil: waitUntilFromEvent(event) })",
    "})",
    "",
  ].join("\n")
}

function generateAgentWebhookRouteHandler(definitions: DiscoveredAgentDefinition[], handlerPath: string): string {
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
      const agentExpression = definition.workspace
        ? `withWorkspaceAgentDefaults(resolveAgentModule(agent${index}), ${JSON.stringify({ name: definition.name, workspace: definition.workspace })})`
        : `resolveAgentModule(agent${index})`
      return `${JSON.stringify(definition.name)}: ${agentExpression}`
    })
    .join(",\n  ")

  return [
    "import { withWorkspaceAgentDefaults } from '@vite-hub/agent'",
    "import { defineAgentChatWebhookFetchHandler } from '@vite-hub/agent/server'",
    "import { setWorkspaceRuntimeRegistry } from '@vite-hub/workspace/internal/runtime/state'",
    "import { createError, defineEventHandler, getRequestHeaders, getRequestURL, getRouterParam, readRawBody } from 'h3'",
    imports,
    "",
    "function resolveAgentModule(module) {",
    "  return module && typeof module === 'object' && 'default' in module ? module.default : module",
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
    "function waitUntilFromEvent(event) {",
    "  return typeof event.waitUntil === 'function' ? event.waitUntil.bind(event) : undefined",
    "}",
    "",
    `setWorkspaceRuntimeRegistry({${workspaceEntries ? `\n  ${workspaceEntries}\n` : ""}})`,
    "",
    `const agents = {${agentEntries ? `\n  ${agentEntries}\n` : ""}}`,
    "const handlers = Object.fromEntries(Object.entries(agents).map(([name, agent]) => [name, defineAgentChatWebhookFetchHandler(agent)]))",
    "",
    "export default defineEventHandler(async (event) => {",
    "  const agent = getRouterParam(event, 'agent')",
    "  const webhook = getRouterParam(event, 'webhook')",
    "  const handler = agent ? handlers[agent] : undefined",
    "  if (!handler) {",
    "    throw createError({ statusCode: 404, statusMessage: 'Unknown ViteHub agent.' })",
    "  }",
    "  return await handler(await toRequest(event), webhook, { agentName: agent, waitUntil: waitUntilFromEvent(event) })",
    "})",
    "",
  ].join("\n")
}

async function writeAgentRouteHandler(root: string): Promise<void> {
  const handlerPath = join(root, generatedAgentRouteHandler)
  const definitions = discoverAgentDefinitions({
    mode: "server-agents",
    scanDirs: [join(root, "server")],
  })
  await mkdir(dirname(handlerPath), { recursive: true })
  await writeFile(handlerPath, generateAgentRouteHandler(definitions, handlerPath), "utf8")
}

async function writeAgentWebhookRouteHandler(root: string): Promise<void> {
  const handlerPath = join(root, generatedAgentWebhookRouteHandler)
  const definitions = discoverAgentDefinitions({
    mode: "server-agents",
    scanDirs: [join(root, "server")],
  })
  await mkdir(dirname(handlerPath), { recursive: true })
  await writeFile(handlerPath, generateAgentWebhookRouteHandler(definitions, handlerPath), "utf8")
}

export function hubAgent(options?: AgentModuleOptions): AgentVitePlugin {
  let agent: AgentModuleOptions | false | undefined = options
  let resolved: ResolvedConfig | undefined
  const chatDevtoolsPlugin = chatDevTools()

  return {
    name: "@vite-hub/agent/vite",
    devtools: {
      setup(ctx) {
        if (agentDevtoolsEnabled(agent)) {
          return chatDevtoolsPlugin.devtools?.setup?.(ctx)
        }
      },
    },
    configureServer(server) {
      if (agentDevtoolsEnabled(agent)) {
        registerChatDevtoolsBridge(server)
      }
    },
    vitehub: {
      cli: async () => {
        const { createAgentCliContributor } = await import(/* @vite-ignore */ "./cli.js")
        if (agent === false || agent?.cli === false) return createAgentCliContributor(false)
        return createAgentCliContributor(resolveAgentEvalOptions(agent?.eval))
      },
    },
    config(config) {
      agent = config.agent ?? agent
      const resolved = normalizeAgentOptions(agent)
      const nitroHandlers = [
        ...(resolved && resolved.route
          ? [{
              handler: generatedAgentRouteHandler,
              route: normalizeNitroRoute(resolved.route),
            }]
          : []),
        ...(resolved && resolved.webhooks
          ? [{
              handler: generatedAgentWebhookRouteHandler,
              route: normalizeNitroRoute(resolved.webhooks),
            }]
          : []),
      ]
      return {
        ...(typeof agent !== "undefined" ? { agent } : {}),
        ...(nitroHandlers.length
          ? {
              nitro: {
                handlers: nitroHandlers,
              },
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
      if (normalized && normalized.route) {
        await writeAgentRouteHandler(config.root)
      }
      if (normalized && normalized.webhooks) {
        await writeAgentWebhookRouteHandler(config.root)
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
