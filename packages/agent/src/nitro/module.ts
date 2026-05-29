import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { createImportPath } from "@vitehub/internal/build/paths"
import { createGeneratedDefinitionPath, sanitizeDefinitionFilename, writeFileIfChanged } from "@vitehub/internal/definition-catalog"
import { mergeNitroImportsPreset, resolveRuntimeEntry as resolveEntry } from "@vitehub/internal/nitro"
import { splitTopLevel } from "@vitehub/internal/source-scanner"

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

interface AgentChatWebhookRouteBinding {
  agent: string
  platform?: string
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

function createNitroAgentCustomChatWebhookRoutePath(rootDir: string, buildDir: string, binding: AgentChatWebhookRouteBinding): string {
  return createGeneratedDefinitionPath(rootDir, {
    buildDir,
    fileName: [
      "chat-webhook",
      sanitizeDefinitionFilename(binding.agent),
      sanitizeDefinitionFilename(binding.platform || "unknown"),
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

function extractObjectBody(source: string, property: string): string | undefined {
  const match = new RegExp(`\\b${property}\\s*:`).exec(source)
  if (!match) return
  const openIndex = source.indexOf("{", match.index + match[0].length)
  if (openIndex === -1) return
  const closeIndex = findMatchingBrace(source, openIndex)
  if (closeIndex === -1) return
  return source.slice(openIndex + 1, closeIndex)
}

function readEntryKey(entry: string): string | undefined {
  const match = /^\s*(?:([A-Za-z_$][\w$]*)|["']([^"']+)["'])\s*:/.exec(entry)
  return match?.[1] || match?.[2]
}

function readEntryValue(entry: string): string | undefined {
  const match = /^\s*(?:[A-Za-z_$][\w$]*|["'][^"']+["'])\s*:/.exec(entry)
  return match ? entry.slice(match[0].length) : undefined
}

function readStaticWebhookPaths(value: string): string[] {
  const paths: string[] = []
  const pattern = /\bpath\s*:\s*(["'])([^"']+)\1/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(value))) {
    const route = match[2]?.trim()
    if (route?.startsWith("/")) paths.push(route)
  }
  return [...new Set(paths)]
}

function readStaticChatWebhookRouteBindings(definition: DiscoveredAgentDefinition): AgentChatWebhookRouteBinding[] {
  const source = stripComments(readFileSync(definition.handler, "utf8"))
  const webhooksBody = extractObjectBody(source, "webhooks")
  if (!webhooksBody) return []

  return splitTopLevel(webhooksBody)
    .flatMap((entry) => {
      const platform = readEntryKey(entry)
      const value = readEntryValue(entry)
      if (!platform || !value) return []
      return readStaticWebhookPaths(value).map(route => ({
        agent: definition.name,
        platform,
        route,
      }))
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

function createNitroAgentChatWebhookRouteContents(file: string, registryFile: string, binding?: Pick<AgentChatWebhookRouteBinding, "agent" | "platform">): string {
  const options = binding
    ? `, { agent: ${JSON.stringify(binding.agent)}, platform: ${JSON.stringify(binding.platform)} }`
    : ""
  return [
    `import agentRegistry from ${JSON.stringify(createImportPath(file, registryFile))}`,
    `import { defineAgentChatWebhookRegistryHandler } from "@vitehub/agent/nitro"`,
    "",
    `export default defineAgentChatWebhookRegistryHandler(agentRegistry${options})`,
    "",
  ].join("\n")
}

interface AgentChatWebhookRouteFile {
  route: string
  routeFile: string
}

interface AgentRuntimeFiles {
  chatWebhookRouteFile?: string
  customChatWebhookRouteFiles: AgentChatWebhookRouteFile[]
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
    return { customChatWebhookRouteFiles: [], definitions }
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
  const customChatWebhookRouteFiles: AgentChatWebhookRouteFile[] = []
  if (definitions.length) {
    chatWebhookRouteFile = createNitroAgentChatWebhookRoutePath(nitro.options.rootDir, nitro.options.buildDir)
    await writeFileIfChanged(chatWebhookRouteFile, createNitroAgentChatWebhookRouteContents(chatWebhookRouteFile, registryFile!))

    const customRoutes = new Map<string, AgentChatWebhookRouteBinding>()
    for (const definition of definitions) {
      for (const binding of readStaticChatWebhookRouteBindings(definition)) {
        const existing = customRoutes.get(binding.route)
        if (existing && (existing.agent !== binding.agent || existing.platform !== binding.platform)) {
          throw new Error(`Duplicate agent chat webhook route "${binding.route}" for ${existing.agent}/${existing.platform} and ${binding.agent}/${binding.platform}.`)
        }
        customRoutes.set(binding.route, binding)
      }
    }
    for (const binding of customRoutes.values()) {
      const routeFile = createNitroAgentCustomChatWebhookRoutePath(nitro.options.rootDir, nitro.options.buildDir, binding)
      await writeFileIfChanged(routeFile, createNitroAgentChatWebhookRouteContents(routeFile, registryFile!, binding))
      customChatWebhookRouteFiles.push({ route: binding.route, routeFile })
    }
  }

  return { chatWebhookRouteFile, customChatWebhookRouteFiles, definitions, registryFile, routeFile }
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

function installCustomChatWebhookRoutes(nitro: Nitro, routeFiles: AgentChatWebhookRouteFile[]): void {
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
      installChatWebhookRoute(nitro, runtimeFiles.chatWebhookRouteFile)
      installCustomChatWebhookRoutes(nitro, runtimeFiles.customChatWebhookRouteFiles)
    }

    nitro.hooks.hook("build:before", async () => {
      runtimeFiles = await writeNitroAgentRuntimeFiles(nitro, resolved)
      installAliases(nitro, runtimeFiles.registryFile)
      if (resolved) {
        installRoute(nitro, resolved, runtimeFiles.routeFile)
        installChatWebhookRoute(nitro, runtimeFiles.chatWebhookRouteFile)
        installCustomChatWebhookRoutes(nitro, runtimeFiles.customChatWebhookRouteFiles)
      }
    })
    nitro.hooks.hook("dev:reload", async () => {
      runtimeFiles = await writeNitroAgentRuntimeFiles(nitro, resolved)
      installAliases(nitro, runtimeFiles.registryFile)
      if (resolved) {
        installRoute(nitro, resolved, runtimeFiles.routeFile)
        installChatWebhookRoute(nitro, runtimeFiles.chatWebhookRouteFile)
        installCustomChatWebhookRoutes(nitro, runtimeFiles.customChatWebhookRouteFiles)
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
