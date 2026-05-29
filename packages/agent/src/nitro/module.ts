import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { createImportPath } from "@vitehub/internal/build/paths"
import { createGeneratedDefinitionPath, sanitizeDefinitionFilename, writeFileIfChanged } from "@vitehub/internal/definition-catalog"
import { mergeNitroImportsPreset, resolveRuntimeEntry as resolveEntry } from "@vitehub/internal/nitro"
import { findIdentifierCalls, splitTopLevel } from "@vitehub/internal/source-scanner"

import { normalizeAgentOptions } from "../config.ts"
import { discoverAgentDefinitions } from "../discovery.ts"

import type { Nitro, NitroRuntimeConfig } from "nitro/types"
import type { AgentModuleOptions, DiscoveredAgentDefinition, ResolvedAgentModuleOptions } from "../types.ts"

export interface AgentNitroModule {
  name: string
  setup(this: void, nitro: unknown): void | Promise<void>
}

const AGENT_NITRO_IMPORTS_PRESET = {
  from: "@vitehub/agent",
  imports: ["defineAgent"],
}
const AGENT_CHAT_WEBHOOK_ROUTE = "/api/agents/[agent]/chat/[platform]"
const AGENT_CHAT_WEBHOOK_ROUTE_FILE = "chat-webhook-handler.ts"
const AGENT_CHAT_APP_DEFAULT_ROUTE = "/api/chat"

interface AgentChatAppRouteBinding {
  agent: string
  route: string
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

function createNitroAgentChatWebhookRoutePath(rootDir: string, buildDir: string): string {
  return createGeneratedDefinitionPath(rootDir, {
    buildDir,
    fileName: AGENT_CHAT_WEBHOOK_ROUTE_FILE,
    segments: [".vitehub", "nitro-runtime", "agent"],
  })
}

function createNitroAgentChatAppRoutePath(rootDir: string, buildDir: string, binding: AgentChatAppRouteBinding): string {
  return createGeneratedDefinitionPath(rootDir, {
    buildDir,
    fileName: [
      "chat-app",
      sanitizeDefinitionFilename(binding.agent),
      sanitizeDefinitionFilename(binding.route),
      "ts",
    ].join("."),
    segments: [".vitehub", "nitro-runtime", "agent"],
  })
}

function normalizeNitroRoute(route: string): string {
  return route.replace(/\[([A-Za-z0-9_]+)\]/g, ":$1")
}

function routeHasParam(route: string, param: string): boolean {
  return route.includes(`[${param}]`) || route.includes(`:${param}`)
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
}

function findMatchingBrace(source: string, openIndex: number): number {
  let depth = 0
  let quote: "\"" | "'" | "`" | undefined
  let escaped = false
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index]!
    if (quote) {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === "\\") {
        escaped = true
        continue
      }
      if (char === quote) quote = undefined
      continue
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char
      continue
    }
    if (char === "{") depth += 1
    if (char === "}") {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

function readEntryKey(entry: string): string | undefined {
  const match = /^\s*(?:([A-Za-z_$][\w$]*)|["']([^"']+)["'])\s*:/.exec(entry)
  return match?.[1] || match?.[2]
}

function readEntryValue(entry: string): string | undefined {
  const match = /^\s*(?:[A-Za-z_$][\w$]*|["'][^"']+["'])\s*:/.exec(entry)
  return match ? entry.slice(match[0].length) : undefined
}

function objectLiteralBody(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed?.startsWith("{")) return
  const closeIndex = findMatchingBrace(trimmed, 0)
  if (closeIndex === -1) return
  return trimmed.slice(1, closeIndex)
}

function readObjectPropertyValue(body: string, property: string): string | undefined {
  for (const entry of splitTopLevel(body)) {
    if (readEntryKey(entry) !== property) continue
    return readEntryValue(entry)?.trim()
  }
}

function readStaticChatAppRoute(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed || trimmed.startsWith("false")) return
  if (trimmed.startsWith("true")) return AGENT_CHAT_APP_DEFAULT_ROUTE

  const body = objectLiteralBody(trimmed)
  if (!body) return
  const route = readObjectPropertyValue(body, "route")
  if (!route || route.startsWith("true")) return AGENT_CHAT_APP_DEFAULT_ROUTE

  const match = /^(["'])([^"']+)\1/.exec(route)
  const routeValue = match?.[2]?.trim()
  return routeValue?.startsWith("/") ? routeValue : undefined
}

function readStaticChatAppRouteBindings(definition: DiscoveredAgentDefinition): AgentChatAppRouteBinding[] {
  const source = stripComments(readFileSync(definition.handler, "utf8"))
  return findIdentifierCalls(source, "chat")
    .flatMap((call) => {
      const body = objectLiteralBody(call.arguments[0])
      if (!body) return []
      const route = readStaticChatAppRoute(readObjectPropertyValue(body, "app"))
      return route ? [{ agent: definition.name, route }] : []
    })
}

function resolveNitroAgentScanDirs(rootDir: string, scanDirs: string[] | undefined) {
  return scanDirs?.length ? scanDirs : [resolve(rootDir, "server")]
}

function createNitroAgentRegistryContents(file: string, definitions: DiscoveredAgentDefinition[]): string {
  return [
    `import { resolveAgentDevtoolsMetadata, withWorkspaceAgentDefaults } from "@vitehub/agent"`,
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
    `import { defineAgentRegistryHandler } from "@vitehub/agent/nitro"`,
    "",
    "export default defineAgentRegistryHandler(agentRegistry)",
    "",
  ].join("\n")
}

function createNitroAgentChatWebhookRouteContents(file: string, registryFile: string): string {
  return [
    `import agentRegistry from ${JSON.stringify(createImportPath(file, registryFile))}`,
    `import { defineAgentChatWebhookRegistryHandler } from "@vitehub/agent/nitro"`,
    "",
    "export default defineAgentChatWebhookRegistryHandler(agentRegistry)",
    "",
  ].join("\n")
}

function createNitroAgentChatAppRouteContents(file: string, registryFile: string, binding: AgentChatAppRouteBinding): string {
  return [
    `import agentRegistry from ${JSON.stringify(createImportPath(file, registryFile))}`,
    `import { defineAgentChatRegistryHandler } from "@vitehub/agent/nitro"`,
    "",
    `export default defineAgentChatRegistryHandler(agentRegistry, { agent: ${JSON.stringify(binding.agent)} })`,
    "",
  ].join("\n")
}

interface AgentRouteFile {
  route: string
  routeFile: string
}

interface AgentRuntimeFiles {
  chatAppRouteFiles: AgentRouteFile[]
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
    return { chatAppRouteFiles: [], definitions }
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
  const chatAppRouteFiles: AgentRouteFile[] = []
  if (definitions.length) {
    chatWebhookRouteFile = createNitroAgentChatWebhookRoutePath(nitro.options.rootDir, nitro.options.buildDir)
    await writeFileIfChanged(chatWebhookRouteFile, createNitroAgentChatWebhookRouteContents(chatWebhookRouteFile, registryFile!))

    const appRoutes = new Map<string, AgentChatAppRouteBinding>()
    for (const definition of definitions) {
      for (const binding of readStaticChatAppRouteBindings(definition)) {
        const existing = appRoutes.get(binding.route)
        if (existing && existing.agent !== binding.agent) {
          throw new Error(`Duplicate agent chat app route "${binding.route}" for ${existing.agent} and ${binding.agent}.`)
        }
        appRoutes.set(binding.route, binding)
      }
    }
    for (const binding of appRoutes.values()) {
      const routeFile = createNitroAgentChatAppRoutePath(nitro.options.rootDir, nitro.options.buildDir, binding)
      await writeFileIfChanged(routeFile, createNitroAgentChatAppRouteContents(routeFile, registryFile!, binding))
      chatAppRouteFiles.push({ route: binding.route, routeFile })
    }
  }

  return { chatAppRouteFiles, chatWebhookRouteFile, definitions, registryFile, routeFile }
}

function installAliases(nitro: Nitro, registryFile: string | undefined): void {
  nitro.options.alias ||= {}
  nitro.options.alias["@vitehub/agent"] = resolveRuntimeEntry("../index", "@vitehub/agent")
  nitro.options.alias["@vitehub/agent/capabilities"] = resolveRuntimeEntry("../capabilities", "@vitehub/agent/capabilities")
  nitro.options.alias["@vitehub/agent/cloudflare"] = resolveRuntimeEntry("../cloudflare", "@vitehub/agent/cloudflare")
  nitro.options.alias["@vitehub/agent/eval"] = resolveRuntimeEntry("../eval", "@vitehub/agent/eval")
  nitro.options.alias["@vitehub/agent/nitro"] = resolveRuntimeEntry("../nitro", "@vitehub/agent/nitro")
  nitro.options.alias["@vitehub/agent/runtime/nitro-runtime-config"] = resolveRuntimeEntry("../runtime/nitro-runtime-config", "@vitehub/agent/runtime/nitro-runtime-config")
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

function installGeneratedPostRoutes(nitro: Nitro, routeFiles: AgentRouteFile[]): void {
  for (const routeFile of routeFiles) {
    installPostRoute(nitro, routeFile.route, routeFile.routeFile)
  }
}

export function agentNitro(options?: false | AgentModuleOptions): AgentNitroModule {
  return {
    name: "@vitehub/agent",
    async setup(nitroInput) {
      const nitro = nitroInput as Nitro
      const configured = options ?? (nitro.options as typeof nitro.options & { agent?: false | AgentModuleOptions }).agent
      const resolved = normalizeAgentOptions(configured)
    const runtimeConfig = (nitro.options.runtimeConfig ||= {} as NitroRuntimeConfig)
    if (nitro.options.preset) runtimeConfig.hosting ||= nitro.options.preset
    runtimeConfig.agent = resolved || false

    installExternals(nitro)

    const importsExplicitlyDisabled = nitro.options._config?.imports === false || (resolved && !resolved.imports)
    if (!importsExplicitlyDisabled) {
      nitro.options.imports = mergeNitroImportsPreset(nitro.options.imports === false ? {} : nitro.options.imports, AGENT_NITRO_IMPORTS_PRESET) as typeof nitro.options.imports
      nitro.options.imports = mergeNitroImportsPreset(nitro.options.imports, {
        from: "@vitehub/agent/nitro",
        imports: ["defineAgentChatHandler", "defineAgentChatRegistryHandler", "defineAgentChatWebhookRegistryHandler", "defineAgentHandler", "defineAgentRegistryHandler"],
      }) as typeof nitro.options.imports
    }

    let runtimeFiles = await writeNitroAgentRuntimeFiles(nitro, resolved)
    installAliases(nitro, runtimeFiles.registryFile)
    if (resolved) {
      installRoute(nitro, resolved, runtimeFiles.routeFile)
      installGeneratedPostRoutes(nitro, runtimeFiles.chatAppRouteFiles)
      installChatWebhookRoute(nitro, runtimeFiles.chatWebhookRouteFile)
    }

    nitro.hooks.hook("build:before", async () => {
      runtimeFiles = await writeNitroAgentRuntimeFiles(nitro, resolved)
      installAliases(nitro, runtimeFiles.registryFile)
      if (resolved) {
        installRoute(nitro, resolved, runtimeFiles.routeFile)
        installGeneratedPostRoutes(nitro, runtimeFiles.chatAppRouteFiles)
        installChatWebhookRoute(nitro, runtimeFiles.chatWebhookRouteFile)
      }
    })
    nitro.hooks.hook("dev:reload", async () => {
      runtimeFiles = await writeNitroAgentRuntimeFiles(nitro, resolved)
      installAliases(nitro, runtimeFiles.registryFile)
      if (resolved) {
        installRoute(nitro, resolved, runtimeFiles.routeFile)
        installGeneratedPostRoutes(nitro, runtimeFiles.chatAppRouteFiles)
        installChatWebhookRoute(nitro, runtimeFiles.chatWebhookRouteFile)
      }
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
