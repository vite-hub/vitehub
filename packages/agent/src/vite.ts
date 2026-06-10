import { existsSync, statSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join, relative } from "node:path"

import { createNoExternalMerger, isServerEnvironment, mergeGeneratedViteHubWatchIgnored } from "@vite-hub/internal/build/vite"

import { chatDevTools } from "./chat/devtools.ts"
import { registerChatDevtoolsBridge } from "./chat/vite/devtools-bridge.ts"
import { normalizeAgentOptions } from "./config.ts"
import { discoverAgentDefinitions } from "./discovery.ts"
import { resolveAgentEvalOptions, writeAgentEvaliteConfig } from "./internal/evalite-config.ts"

import type { Plugin } from "vite"
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

function agentDevtoolsEnabled(agent: AgentModuleOptions | false | undefined): boolean {
  return agent !== false && agent?.devtools !== false
}

function normalizeNitroRoute(route: string): string {
  const normalized = route.startsWith("/") ? route : `/${route}`
  return normalized.replace(/\[agent\]/g, ":agent")
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
    "import { createError, defineEventHandler, getRouterParam } from 'h3'",
    imports,
    "",
    "function resolveAgentModule(module) {",
    "  return module && typeof module === 'object' && 'default' in module ? module.default : module",
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
    "  return await handler(event.req)",
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

export function hubAgent(options?: AgentModuleOptions): AgentVitePlugin {
  let agent: AgentModuleOptions | false | undefined = options
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
      return {
        ...(typeof agent !== "undefined" ? { agent } : {}),
        ...(resolved && resolved.route
          ? {
              nitro: {
                handlers: [
                  {
                    handler: generatedAgentRouteHandler,
                    route: normalizeNitroRoute(resolved.route),
                  },
                ],
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
      agent = config.agent ?? agent
      const resolved = normalizeAgentOptions(agent)
      if (resolved && resolved.route) {
        await writeAgentRouteHandler(config.root)
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
  }
}

declare module "vite" {
  interface UserConfig {
    agent?: false | AgentModuleOptions
  }
}
