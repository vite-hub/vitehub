import { createImportPath } from "@vitehub/internal/build/paths"
import { createGeneratedDefinitionPath, writeFileIfChanged } from "@vitehub/internal/definition-catalog"
import { mergeNitroImportsPreset, resolveRuntimeEntry as resolveEntry } from "@vitehub/internal/nitro"
import { resolve } from "node:path"

import { normalizeAgentOptions } from "../config.ts"
import { discoverAgentDefinitions } from "../discovery.ts"

import type { Nitro, NitroModule, NitroRuntimeConfig } from "nitro/types"
import type { AgentModuleOptions, DiscoveredAgentDefinition, ResolvedAgentModuleOptions } from "../types.ts"

const AGENT_NITRO_IMPORTS_PRESET = {
  from: "@vitehub/agent",
  imports: ["defineAgent"],
}

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

function createNitroAgentChatRoutePath(rootDir: string, buildDir: string): string {
  return createGeneratedDefinitionPath(rootDir, {
    buildDir,
    fileName: "chat-route-handler.ts",
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
    `import { withWorkspaceAgentDefaults } from "@vitehub/agent"`,
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
    "export default registry",
    "",
  ].join("\n")
}

function createNitroAgentRouteContents(file: string, registryFile: string): string {
  return [
    `import agentRegistry from ${JSON.stringify(createImportPath(file, registryFile))}`,
    `import { defineAgentRegistryHandler } from "@vitehub/agent/nitro"`,
    "",
    "export default defineAgentRegistryHandler(agentRegistry)",
    "",
  ].join("\n")
}

function createNitroAgentChatRouteContents(file: string, registryFile: string): string {
  return [
    `import agentRegistry from ${JSON.stringify(createImportPath(file, registryFile))}`,
    `import { defineAgentChatRegistryHandler } from "@vitehub/agent/nitro"`,
    "",
    "export default defineAgentChatRegistryHandler(agentRegistry)",
    "",
  ].join("\n")
}

interface AgentRuntimeFiles {
  chatRouteFile?: string
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
  let chatRouteFile: string | undefined
  if (definitions.length) {
    chatRouteFile = createNitroAgentChatRoutePath(nitro.options.rootDir, nitro.options.buildDir)
    await writeFileIfChanged(chatRouteFile, createNitroAgentChatRouteContents(chatRouteFile, registryFile!))
  }

  return { chatRouteFile, definitions, registryFile, routeFile }
}

function installAliases(nitro: Nitro, registryFile: string | undefined): void {
  nitro.options.alias ||= {}
  nitro.options.alias["@vitehub/agent"] = resolveRuntimeEntry("../index", "@vitehub/agent")
  nitro.options.alias["@vitehub/agent/ai-sdk"] = resolveRuntimeEntry("../ai-sdk", "@vitehub/agent/ai-sdk")
  nitro.options.alias["@vitehub/agent/capabilities"] = resolveRuntimeEntry("../capabilities", "@vitehub/agent/capabilities")
  nitro.options.alias["@vitehub/agent/cloudflare"] = resolveRuntimeEntry("../cloudflare", "@vitehub/agent/cloudflare")
  nitro.options.alias["@vitehub/agent/chat/runtime/agent-chat"] = resolveRuntimeEntry("../chat/runtime/agent-chat", "@vitehub/agent/chat/runtime/agent-chat")
  nitro.options.alias["@vitehub/agent/chat/runtime/workspace-state"] = resolveRuntimeEntry("../chat/runtime/workspace-state", "@vitehub/agent/chat/runtime/workspace-state")
  nitro.options.alias["@vitehub/agent/nitro"] = resolveRuntimeEntry("../nitro", "@vitehub/agent/nitro")
  nitro.options.alias["@vitehub/agent/runtime/nitro-runtime-config"] = resolveRuntimeEntry("../runtime/nitro-runtime-config", "@vitehub/agent/runtime/nitro-runtime-config")
  nitro.options.alias["@vitehub/agent/tanstack-ai"] = resolveRuntimeEntry("../tanstack-ai", "@vitehub/agent/tanstack-ai")
  nitro.options.alias["@vitehub/agent/vercel"] = resolveRuntimeEntry("../vercel", "@vitehub/agent/vercel")
  nitro.options.alias["#vitehub/agent/registry"] = registryFile || resolveRuntimeEntry("../runtime/empty-registry", "@vitehub/agent/runtime/empty-registry")
}

function installExternals(nitro: Nitro): void {
  const options = nitro.options as Nitro["options"] & {
    externals?: { inline?: string[] }
  }
  options.externals ||= {}
  options.externals.inline ||= []
  for (const dependency of ["@vitehub/agent", "ai", "chat"]) {
    if (!options.externals.inline.includes(dependency)) {
      options.externals.inline.push(dependency)
    }
  }
}

function installChatRoute(nitro: Nitro, chatRouteFile: string | undefined): void {
  if (!chatRouteFile) return
  nitro.options.handlers ||= []
  const route = "/api/agents/:agent/chat/:platform"
  const existing = nitro.options.handlers.some(handler => handler.route === route && handler.method === "POST" && handler.handler === chatRouteFile)
  if (!existing) {
    nitro.options.handlers.push({ handler: chatRouteFile, method: "POST", route })
  }
}

function installRoute(nitro: Nitro, options: ResolvedAgentModuleOptions, routeFile: string | undefined): void {
  if (!routeFile || !options.route) {
    return
  }

  const route = normalizeNitroRoute(options.route)
  nitro.options.handlers ||= []
  const existing = nitro.options.handlers.some(handler => handler.route === route && handler.method === "POST" && handler.handler === routeFile)
  if (!existing) {
    nitro.options.handlers.push({
      handler: routeFile,
      method: "POST",
      route,
    })
  }
}

const agentNitroModule: NitroModule = {
  name: "@vitehub/agent",
  async setup(nitro) {
    const resolved = normalizeAgentOptions((nitro.options as typeof nitro.options & { agent?: false | AgentModuleOptions }).agent)
    const runtimeConfig = (nitro.options.runtimeConfig ||= {} as NitroRuntimeConfig)
    if (nitro.options.preset) runtimeConfig.hosting ||= nitro.options.preset
    runtimeConfig.agent = resolved || false

    installExternals(nitro)

    const importsExplicitlyDisabled = nitro.options._config?.imports === false || (resolved && !resolved.imports)
    if (!importsExplicitlyDisabled) {
      nitro.options.imports = mergeNitroImportsPreset(nitro.options.imports === false ? {} : nitro.options.imports, AGENT_NITRO_IMPORTS_PRESET) as typeof nitro.options.imports
      nitro.options.imports = mergeNitroImportsPreset(nitro.options.imports, {
        from: "@vitehub/agent/nitro",
        imports: ["defineAgentChatRegistryHandler", "defineAgentHandler", "defineAgentRegistryHandler"],
      }) as typeof nitro.options.imports
    }

    let runtimeFiles = await writeNitroAgentRuntimeFiles(nitro, resolved)
    installAliases(nitro, runtimeFiles.registryFile)
    if (resolved) {
      installRoute(nitro, resolved, runtimeFiles.routeFile)
      installChatRoute(nitro, runtimeFiles.chatRouteFile)
    }

    nitro.hooks.hook("build:before", async () => {
      runtimeFiles = await writeNitroAgentRuntimeFiles(nitro, resolved)
      installAliases(nitro, runtimeFiles.registryFile)
      if (resolved) {
        installRoute(nitro, resolved, runtimeFiles.routeFile)
        installChatRoute(nitro, runtimeFiles.chatRouteFile)
      }
    })
    nitro.hooks.hook("dev:reload", async () => {
      runtimeFiles = await writeNitroAgentRuntimeFiles(nitro, resolved)
      installAliases(nitro, runtimeFiles.registryFile)
      if (resolved) {
        installRoute(nitro, resolved, runtimeFiles.routeFile)
        installChatRoute(nitro, runtimeFiles.chatRouteFile)
      }
    })
  },
}

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
