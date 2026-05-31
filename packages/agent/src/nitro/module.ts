import { resolve } from "node:path"

import { createImportPath } from "@vite-hub/internal/build/paths"
import { createGeneratedDefinitionPath, writeFileIfChanged } from "@vite-hub/internal/definition-catalog"
import { mergeNitroImportsPreset, resolveRuntimeEntry as resolveEntry } from "@vite-hub/internal/nitro"

import { normalizeAgentOptions } from "../config.ts"
import { discoverAgentDefinitions } from "../discovery.ts"
import { appendCloudflareAgentStateClassExport, installCloudflareAgentStateProvider, isCloudflarePreset } from "../state/providers/cloudflare-nitro.ts"

import type { Nitro, NitroRuntimeConfig } from "nitro/types"
import type { AgentModuleOptions, DiscoveredAgentDefinition, ResolvedAgentModuleOptions } from "../types.ts"

export interface AgentNitroModule {
  name: string
  setup(this: void, nitro: unknown): void | Promise<void>
}

const AGENT_NITRO_IMPORTS_PRESET = {
  from: "@vite-hub/agent",
  imports: ["defineAgent"],
}
const AGENT_CHAT_WEBHOOK_ROUTE = "/api/_vitehub/agents/[agent]/chat/[platform]"
const AGENT_CHAT_APP_AGENT_ROUTE = "/api/_vitehub/agents/[agent]/chat"
const AGENT_CHAT_APP_ROUTE_FILE = "chat-app-handler.ts"
const AGENT_CHAT_WEBHOOK_ROUTE_FILE = "chat-webhook-handler.ts"

function resolveRuntimeEntry(srcRelative: string, packageSubpath: string): string {
  return resolveEntry(srcRelative, packageSubpath, import.meta.url)
}

function createNitroAgentRegistryPath(rootDir: string, buildDir: string): string {
  return createGeneratedDefinitionPath(rootDir, {
    buildDir,
    fileName: "nitro-registry.ts",
    segments: [".vitehub", "nitro-runtime", "agent"],
  })
}

function createNitroAgentRoutePath(rootDir: string, buildDir: string): string {
  return createGeneratedDefinitionPath(rootDir, {
    buildDir,
    fileName: "route-handler.ts",
    segments: [".vitehub", "nitro-runtime", "agent"],
  })
}

function createNitroAgentChatWebhookRoutePath(rootDir: string, buildDir: string): string {
  return createGeneratedDefinitionPath(rootDir, {
    buildDir,
    fileName: AGENT_CHAT_WEBHOOK_ROUTE_FILE,
    segments: [".vitehub", "nitro-runtime", "agent"],
  })
}

function createNitroAgentChatAppRoutePath(rootDir: string, buildDir: string): string {
  return createGeneratedDefinitionPath(rootDir, {
    buildDir,
    fileName: AGENT_CHAT_APP_ROUTE_FILE,
    segments: [".vitehub", "nitro-runtime", "agent"],
  })
}

function normalizeNitroRoute(route: string): string {
  return route.replace(/\[([A-Za-z0-9_]+)\]/g, ":$1")
}

function routeHasParam(route: string, param: string): boolean {
  return route.includes(`[${param}]`) || route.includes(`:${param}`)
}

function resolveNitroAgentScanDirs(rootDir: string, scanDirs: string[] | undefined) {
  return scanDirs?.length ? scanDirs : [resolve(rootDir, "server")]
}

function createNitroAgentRegistryContents(file: string, definitions: DiscoveredAgentDefinition[]): string {
  return [
    `import { resolveAgentDevtoolsMetadata, withWorkspaceAgentDefaults } from "@vite-hub/agent"`,
    "",
    "const registry = {",
    ...definitions.map((definition) => {
      const importPath = createImportPath(file, definition.handler)
      if (definition.source === "nitro-server-agent-workspace") {
        return `  ${JSON.stringify(definition.name)}: async () => ({ default: withWorkspaceAgentDefaults((await import(${JSON.stringify(importPath)})).default, { name: ${JSON.stringify(definition.name)}, workspace: ${JSON.stringify(definition.workspace)} }) }),`
      }
      if (definition.exportName) {
        return `  ${JSON.stringify(definition.name)}: async () => ({ default: (await import(${JSON.stringify(importPath)}))[${JSON.stringify(definition.exportName)}] }),`
      }
      return `  ${JSON.stringify(definition.name)}: async () => import(${JSON.stringify(importPath)}),`
    }),
    "}",
    "",
    "export const metadata = Object.fromEntries(Object.entries(registry).map(([name, load]) => [name, async () => resolveAgentDevtoolsMetadata((await load()).default)]))",
    "export default registry",
    "",
  ].join("\n")
}

function createNitroAgentRouteContents(file: string, registryFile: string): string {
  return [
    `import agentRegistry from ${JSON.stringify(createImportPath(file, registryFile))}`,
    `import { defineAgentRegistryHandler } from "@vite-hub/agent/nitro"`,
    "",
    "export default defineAgentRegistryHandler(agentRegistry)",
    "",
  ].join("\n")
}

function createNitroAgentChatWebhookRouteContents(file: string, registryFile: string): string {
  return [
    `import agentRegistry from ${JSON.stringify(createImportPath(file, registryFile))}`,
    `import { defineAgentChatWebhookRegistryHandler } from "@vite-hub/agent/nitro"`,
    "",
    "export default defineAgentChatWebhookRegistryHandler(agentRegistry)",
    "",
  ].join("\n")
}

function createNitroAgentChatAppRouteContents(file: string, registryFile: string): string {
  return [
    `import agentRegistry from ${JSON.stringify(createImportPath(file, registryFile))}`,
    `import { defineAgentChatRegistryHandler } from "@vite-hub/agent/nitro"`,
    "",
    "export default defineAgentChatRegistryHandler(agentRegistry)",
    "",
  ].join("\n")
}

interface AgentRuntimeFiles {
  chatAppRouteFile?: string
  chatWebhookRouteFile?: string
  definitions: DiscoveredAgentDefinition[]
  registryFile?: string
  routeFile?: string
}

async function writeNitroAgentRuntimeFiles(nitro: Nitro, options: false | ResolvedAgentModuleOptions): Promise<AgentRuntimeFiles> {
  const definitions = discoverAgentDefinitions({
    mode: "nitro-server-agents",
    scanDirs: resolveNitroAgentScanDirs(nitro.options.rootDir, nitro.options.scanDirs),
  })

  if (!options) {
    return { definitions }
  }

  let registryFile: string | undefined
  if (definitions.length) {
    registryFile = createNitroAgentRegistryPath(nitro.options.rootDir, nitro.options.buildDir)
    await writeFileIfChanged(registryFile, createNitroAgentRegistryContents(registryFile, definitions))
  }

  let routeFile: string | undefined
  if (options.route && definitions.length) {
    if (!routeHasParam(options.route, "agent")) {
      throw new Error("agent.route must include [agent] or :agent when generated routes are enabled.")
    }
    routeFile = createNitroAgentRoutePath(nitro.options.rootDir, nitro.options.buildDir)
    await writeFileIfChanged(routeFile, createNitroAgentRouteContents(routeFile, registryFile!))
  }

  let chatWebhookRouteFile: string | undefined
  let chatAppRouteFile: string | undefined
  if (definitions.length) {
    chatWebhookRouteFile = createNitroAgentChatWebhookRoutePath(nitro.options.rootDir, nitro.options.buildDir)
    await writeFileIfChanged(chatWebhookRouteFile, createNitroAgentChatWebhookRouteContents(chatWebhookRouteFile, registryFile!))

    chatAppRouteFile = createNitroAgentChatAppRoutePath(nitro.options.rootDir, nitro.options.buildDir)
    await writeFileIfChanged(chatAppRouteFile, createNitroAgentChatAppRouteContents(chatAppRouteFile, registryFile!))
  }

  return { chatAppRouteFile, chatWebhookRouteFile, definitions, registryFile, routeFile }
}

function installAliases(nitro: Nitro, registryFile: string | undefined): void {
  nitro.options.alias ||= {}
  nitro.options.alias["@vite-hub/agent"] = resolveRuntimeEntry("../index", "@vite-hub/agent")
  nitro.options.alias["@vite-hub/agent/capabilities"] = resolveRuntimeEntry("../capabilities", "@vite-hub/agent/capabilities")
  nitro.options.alias["@vite-hub/agent/chat/telegram"] = resolveRuntimeEntry("../chat/telegram", "@vite-hub/agent/chat/telegram")
  nitro.options.alias["@vite-hub/agent/cloudflare"] = resolveRuntimeEntry("../cloudflare", "@vite-hub/agent/cloudflare")
  nitro.options.alias["@vite-hub/agent/cloudflare/state"] = resolveRuntimeEntry("../cloudflare/state", "@vite-hub/agent/cloudflare/state")
  nitro.options.alias["@vite-hub/agent/eval"] = resolveRuntimeEntry("../eval", "@vite-hub/agent/eval")
  nitro.options.alias["@vite-hub/agent/nitro"] = resolveRuntimeEntry("../nitro", "@vite-hub/agent/nitro")
  nitro.options.alias["@vite-hub/agent/runtime/nitro-runtime-config"] = resolveRuntimeEntry("../runtime/nitro-runtime-config", "@vite-hub/agent/runtime/nitro-runtime-config")
  nitro.options.alias["@vite-hub/agent/vercel"] = resolveRuntimeEntry("../vercel", "@vite-hub/agent/vercel")
  nitro.options.alias["#vitehub/agent/registry"] = registryFile || resolveRuntimeEntry("../runtime/empty-registry", "@vite-hub/agent/runtime/empty-registry")
}

function installExternals(nitro: Nitro): void {
  const options = nitro.options as Nitro["options"] & {
    externals?: { inline?: string[] }
  }
  options.externals ||= {}
  options.externals.inline ||= []
  for (const dependency of ["@vite-hub/agent", "ai", "chat"]) {
    if (!options.externals.inline.includes(dependency)) {
      options.externals.inline.push(dependency)
    }
  }
}

function installPostRoute(nitro: Nitro, route: string, routeFile: string | undefined): void {
  if (!routeFile) {
    return
  }

  const normalizedRoute = normalizeNitroRoute(route)
  nitro.options.handlers ||= []
  const existing = nitro.options.handlers.some(handler => handler.route === normalizedRoute && handler.method === "POST" && handler.handler === routeFile)
  if (!existing) {
    nitro.options.handlers.push({
      handler: routeFile,
      method: "POST",
      route: normalizedRoute,
    })
  }
}

function installRoute(nitro: Nitro, options: ResolvedAgentModuleOptions, routeFile: string | undefined): void {
  if (!routeFile || !options.route) {
    return
  }

  installPostRoute(nitro, options.route, routeFile)
}

function installChatWebhookRoute(nitro: Nitro, routeFile: string | undefined): void {
  installPostRoute(nitro, AGENT_CHAT_WEBHOOK_ROUTE, routeFile)
}

function installChatAppRoutes(nitro: Nitro, routeFile: string | undefined): void {
  installPostRoute(nitro, AGENT_CHAT_APP_AGENT_ROUTE, routeFile)
}

function setAgentRuntimeConfig(runtimeConfig: NitroRuntimeConfig, options: false | ResolvedAgentModuleOptions, cloudflareStateInstalled: boolean): void {
  if (!options) {
    runtimeConfig.agent = false
    return
  }
  let stateProvider = options.providers.state.provider
  if (stateProvider === "auto") {
    stateProvider = cloudflareStateInstalled ? "cloudflare" : "memory"
  }
  runtimeConfig.agent = {
    ...options,
    providers: {
      ...options.providers,
      state: {
        ...options.providers.state,
        provider: stateProvider,
      },
    },
  }
}

export function agentNitro(options?: false | AgentModuleOptions): AgentNitroModule {
  return {
    name: "@vite-hub/agent",
    async setup(nitroInput) {
      const nitro = nitroInput as Nitro
      const configured = options ?? (nitro.options as typeof nitro.options & { agent?: false | AgentModuleOptions }).agent
      const resolved = normalizeAgentOptions(configured)
      const runtimeConfig = (nitro.options.runtimeConfig ||= {} as NitroRuntimeConfig)
      if (nitro.options.preset) runtimeConfig.hosting ||= nitro.options.preset

      installExternals(nitro)

      const importsExplicitlyDisabled = nitro.options._config?.imports === false || (resolved && !resolved.imports)
      if (!importsExplicitlyDisabled) {
        nitro.options.imports = mergeNitroImportsPreset(nitro.options.imports === false ? {} : nitro.options.imports, AGENT_NITRO_IMPORTS_PRESET) as typeof nitro.options.imports
        nitro.options.imports = mergeNitroImportsPreset(nitro.options.imports, {
          from: "@vite-hub/agent/nitro",
          imports: ["defineAgentChatHandler", "defineAgentChatRegistryHandler", "defineAgentChatWebhookRegistryHandler", "defineAgentHandler", "defineAgentRegistryHandler"],
        }) as typeof nitro.options.imports
      }

      let runtimeFiles = await writeNitroAgentRuntimeFiles(nitro, resolved)
      installAliases(nitro, runtimeFiles.registryFile)
      let shouldExportCloudflareAgentStateDO = installCloudflareAgentStateProvider(nitro, resolved)
      setAgentRuntimeConfig(runtimeConfig, resolved, shouldExportCloudflareAgentStateDO)
      if (resolved) {
        installRoute(nitro, resolved, runtimeFiles.routeFile)
        installChatAppRoutes(nitro, runtimeFiles.chatAppRouteFile)
        installChatWebhookRoute(nitro, runtimeFiles.chatWebhookRouteFile)
      }

      nitro.hooks.hook("build:before", async () => {
        runtimeFiles = await writeNitroAgentRuntimeFiles(nitro, resolved)
        installAliases(nitro, runtimeFiles.registryFile)
        const installedCloudflareAgentStateDO = installCloudflareAgentStateProvider(nitro, resolved)
        shouldExportCloudflareAgentStateDO = installedCloudflareAgentStateDO || shouldExportCloudflareAgentStateDO
        setAgentRuntimeConfig(runtimeConfig, resolved, installedCloudflareAgentStateDO)
        if (resolved) {
          installRoute(nitro, resolved, runtimeFiles.routeFile)
          installChatAppRoutes(nitro, runtimeFiles.chatAppRouteFile)
          installChatWebhookRoute(nitro, runtimeFiles.chatWebhookRouteFile)
        }
      })
      nitro.hooks.hook("dev:reload", async () => {
        runtimeFiles = await writeNitroAgentRuntimeFiles(nitro, resolved)
        installAliases(nitro, runtimeFiles.registryFile)
        const installedCloudflareAgentStateDO = installCloudflareAgentStateProvider(nitro, resolved)
        shouldExportCloudflareAgentStateDO = installedCloudflareAgentStateDO || shouldExportCloudflareAgentStateDO
        setAgentRuntimeConfig(runtimeConfig, resolved, installedCloudflareAgentStateDO)
        if (resolved) {
          installRoute(nitro, resolved, runtimeFiles.routeFile)
          installChatAppRoutes(nitro, runtimeFiles.chatAppRouteFile)
          installChatWebhookRoute(nitro, runtimeFiles.chatWebhookRouteFile)
        }
      })
      nitro.hooks.hook("compiled", async (currentNitro) => {
        if (!shouldExportCloudflareAgentStateDO || !isCloudflarePreset(currentNitro)) {
          return
        }
        await appendCloudflareAgentStateClassExport(currentNitro)
      })
    },
  }
}

const agentNitroModule: AgentNitroModule = agentNitro()

export default agentNitroModule

declare module "nitro/types" {
  interface NitroConfig {
    agent?: false | AgentModuleOptions
  }

  interface NitroOptions {
    agent?: false | AgentModuleOptions
  }

  interface NitroRuntimeConfig {
    agent?: false | ResolvedAgentModuleOptions
    hosting?: string
  }
}
