import { createImportPath } from "@vitehub/internal/build/paths"
import { createGeneratedDefinitionPath, createRuntimeRegistryContents, writeFileIfChanged } from "@vitehub/internal/definition-catalog"
import { mergeNitroImportsPreset, resolveRuntimeEntry as resolveEntry } from "@vitehub/internal/nitro"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import { defaultChatCloudflareDurableObjectName, normalizeChatOptions } from "../config.ts"
import { discoverChatDefinitions } from "../discovery.ts"
import { configureCloudflareChatState, discoverCloudflareChatStateConfig } from "../integrations/cloudflare.ts"

import type { Nitro, NitroModule, NitroRuntimeConfig } from "nitro/types"
import type { ChatModuleOptions, DiscoveredChatDefinition, ResolvedChatModuleOptions } from "../types.ts"

const CHAT_NITRO_IMPORTS_PRESET = {
  from: "@vitehub/chat",
  imports: ["defineChat"],
}

function resolveRuntimeEntry(srcRelative: string, packageSubpath: string): string {
  return resolveEntry(srcRelative, packageSubpath, import.meta.url)
}

function createNitroChatRoutePath(rootDir: string, buildDir: string): string {
  return createGeneratedDefinitionPath(rootDir, {
    buildDir,
    fileName: "webhook-handler.mjs",
    segments: [".vitehub", "nitro-runtime", "chat"],
  })
}

function createNitroChatRegistryPath(rootDir: string, buildDir: string): string {
  return createGeneratedDefinitionPath(rootDir, {
    buildDir,
    fileName: "nitro-registry.mjs",
    segments: [".vitehub", "nitro-runtime", "chat"],
  })
}

function normalizeNitroRoute(route: string): string {
  return route.replace(/\[([A-Za-z0-9_]+)\]/g, ":$1")
}

function routeHasParam(route: string, param: string): boolean {
  return route.includes(`[${param}]`) || route.includes(`:${param}`)
}

function resolveNitroChatScanDirs(rootDir: string, scanDirs: string[] | undefined) {
  return scanDirs?.length ? scanDirs : [resolve(rootDir, "server")]
}

function resolveChatProvider(nitro: Nitro, options: ResolvedChatModuleOptions): "cloudflare" | "nitro" | "vercel" {
  if (options.provider !== "auto") {
    return options.provider
  }

  const preset = nitro.options.preset || ""
  if (preset.includes("cloudflare") || typeof nitro.options.cloudflare !== "undefined") {
    return "cloudflare"
  }
  if (preset.includes("vercel")) {
    return "vercel"
  }
  return "nitro"
}

async function readPackageName(rootDir: string): Promise<string | undefined> {
  try {
    const contents = await readFile(resolve(rootDir, "package.json"), "utf8")
    const pkg = JSON.parse(contents) as { name?: unknown }
    return typeof pkg.name === "string" && pkg.name.trim() ? pkg.name : undefined
  }
  catch {
    return undefined
  }
}

async function resolveCloudflareDurableObjectStateName(nitro: Nitro, configuredName?: string): Promise<string> {
  if (configuredName) {
    return configuredName
  }

  const wranglerName = (nitro.options.cloudflare as { wrangler?: { name?: unknown } } | undefined)?.wrangler?.name
  if (typeof wranglerName === "string" && wranglerName.trim()) {
    return wranglerName
  }

  return await readPackageName(nitro.options.rootDir) || defaultChatCloudflareDurableObjectName
}

function setCloudflareDurableObjectRuntimeConfig(
  options: ResolvedChatModuleOptions,
  durableObjectState: Exclude<ResolvedChatModuleOptions["cloudflare"], undefined>["durableObjectState"],
): void {
  options.cloudflare ||= {}
  options.cloudflare.durableObjectState = durableObjectState
}

function renderOptions(options: Record<string, string | undefined>): string {
  const entries = Object.entries(options)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, value]) => `  ${key}: ${JSON.stringify(value)},`)
  return ["{", ...entries, "}"].join("\n")
}

function createNitroSingleChatRouteContents(file: string, definition: DiscoveredChatDefinition, options: ResolvedChatModuleOptions): string {
  return [
    `import chat from ${JSON.stringify(createImportPath(file, definition.handler))}`,
    `import { defineChatWebhookHandler } from "@vitehub/chat/nitro"`,
    "",
    `export default defineChatWebhookHandler(chat, ${renderOptions({
      inferredName: definition.name,
      routeParam: options.webhook && options.webhook.routeParam !== "platform" ? options.webhook.routeParam : undefined,
    })})`,
    "",
  ].join("\n")
}

function createNitroRegistryChatRouteContents(file: string, registryFile: string, options: ResolvedChatModuleOptions): string {
  return [
    `import chatRegistry from ${JSON.stringify(createImportPath(file, registryFile))}`,
    `import { defineChatWebhookRegistryHandler } from "@vitehub/chat/nitro"`,
    "",
    `export default defineChatWebhookRegistryHandler(chatRegistry, ${renderOptions({
      chatParam: options.webhook && options.webhook.chatParam !== "chat" ? options.webhook.chatParam : undefined,
      routeParam: options.webhook && options.webhook.routeParam !== "platform" ? options.webhook.routeParam : undefined,
    })})`,
    "",
  ].join("\n")
}

interface ChatRuntimeFiles {
  definitions: DiscoveredChatDefinition[]
  registryFile?: string
  routeFile?: string
}

async function writeNitroChatRuntimeFiles(nitro: Nitro, options: false | ResolvedChatModuleOptions): Promise<ChatRuntimeFiles> {
  const definitions = discoverChatDefinitions({
    mode: "nitro-server-chats",
    scanDirs: resolveNitroChatScanDirs(nitro.options.rootDir, nitro.options.scanDirs),
  })

  if (!options || !options.webhook || !definitions.length) {
    return { definitions }
  }

  const routeFile = createNitroChatRoutePath(nitro.options.rootDir, nitro.options.buildDir)
  const route = options.webhook.route
  const hasChatParam = routeHasParam(route, options.webhook.chatParam)
  if (definitions.length > 1 && !hasChatParam) {
    throw new Error(`Multiple chat definitions were discovered, but chat.webhook.route does not include [${options.webhook.chatParam}]. Use a route such as /api/webhooks/[${options.webhook.chatParam}]/[${options.webhook.routeParam}].`)
  }

  if (hasChatParam) {
    const registryFile = createNitroChatRegistryPath(nitro.options.rootDir, nitro.options.buildDir)
    await writeFileIfChanged(registryFile, createRuntimeRegistryContents(registryFile, definitions))
    await writeFileIfChanged(routeFile, createNitroRegistryChatRouteContents(routeFile, registryFile, options))
    return { definitions, registryFile, routeFile }
  }

  await writeFileIfChanged(routeFile, createNitroSingleChatRouteContents(routeFile, definitions[0]!, options))
  return { definitions, routeFile }
}

function installAliases(nitro: Nitro): void {
  nitro.options.alias ||= {}
  nitro.options.alias["@vitehub/chat"] = resolveRuntimeEntry("../index", "@vitehub/chat")
  nitro.options.alias["@vitehub/chat/cloudflare"] = resolveRuntimeEntry("../cloudflare", "@vitehub/chat/cloudflare")
  nitro.options.alias["@vitehub/chat/nitro"] = resolveRuntimeEntry("../nitro", "@vitehub/chat/nitro")
  nitro.options.alias["@vitehub/chat/runtime/nitro-runtime-config"] = resolveRuntimeEntry("../runtime/nitro-runtime-config", "@vitehub/chat/runtime/nitro-runtime-config")
  nitro.options.alias["@vitehub/chat/runtime/nitro-plugin"] = resolveRuntimeEntry("../runtime/nitro-plugin", "@vitehub/chat/runtime/nitro-plugin")
  nitro.options.alias["@vitehub/chat/vercel"] = resolveRuntimeEntry("../vercel", "@vitehub/chat/vercel")
}

function installNitroPlugin(nitro: Nitro): void {
  nitro.options.plugins ||= []
  const plugin = resolveRuntimeEntry("../runtime/nitro-plugin", "@vitehub/chat/runtime/nitro-plugin")
  if (!nitro.options.plugins.includes(plugin)) {
    nitro.options.plugins.push(plugin)
  }
}

function installExternals(nitro: Nitro): void {
  const options = nitro.options as Nitro["options"] & {
    externals?: { inline?: string[] }
  }
  options.externals ||= {}
  options.externals.inline ||= []
  for (const dependency of ["@vitehub/chat", "chat", "chat-state-cloudflare-do"]) {
    if (!options.externals.inline.includes(dependency)) {
      options.externals.inline.push(dependency)
    }
  }
}

function installRoute(nitro: Nitro, options: ResolvedChatModuleOptions, routeFile: string | undefined): void {
  if (!routeFile || !options.webhook) {
    return
  }

  const route = normalizeNitroRoute(options.webhook.route)
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

async function installCloudflareStateConfig(
  nitro: Nitro,
  options: ResolvedChatModuleOptions,
  definitions: DiscoveredChatDefinition[],
): Promise<void> {
  const durableObjectState = options.cloudflare?.durableObjectState
  if (durableObjectState === false) {
    return
  }

  if (durableObjectState) {
    const config = {
      ...durableObjectState,
      name: await resolveCloudflareDurableObjectStateName(nitro, durableObjectState.name),
    }
    setCloudflareDurableObjectRuntimeConfig(options, config)

    if (config.autoWrangler) {
      configureCloudflareChatState(nitro.options, {
        binding: config.binding,
        className: config.className,
        migrationTag: config.migrationTag,
      })
    }
    return
  }

  if (resolveChatProvider(nitro, options) !== "cloudflare") {
    return
  }

  const name = await resolveCloudflareDurableObjectStateName(nitro)
  setCloudflareDurableObjectRuntimeConfig(options, {
    autoWrangler: true,
    binding: "CHAT_STATE",
    className: "ChatStateDO",
    migrationTag: "v1",
    name,
  })

  for (const config of await discoverCloudflareChatStateConfig(definitions)) {
    configureCloudflareChatState(nitro.options, {
      binding: config.binding,
      className: config.className,
      migrationTag: config.migrationTag,
    })
  }
}

const chatNitroModule: NitroModule = {
  name: "@vitehub/chat",
  async setup(nitro) {
    const resolved = normalizeChatOptions((nitro.options as typeof nitro.options & { chat?: false | ChatModuleOptions }).chat)
    const runtimeConfig = (nitro.options.runtimeConfig ||= {} as NitroRuntimeConfig)
    if (nitro.options.preset) runtimeConfig.hosting ||= nitro.options.preset
    runtimeConfig.chat = resolved || false

    installAliases(nitro)
    installNitroPlugin(nitro)
    installExternals(nitro)

    const importsExplicitlyDisabled = nitro.options._config?.imports === false || (resolved && !resolved.imports)
    if (!importsExplicitlyDisabled) {
      nitro.options.imports = mergeNitroImportsPreset(nitro.options.imports === false ? {} : nitro.options.imports, CHAT_NITRO_IMPORTS_PRESET) as typeof nitro.options.imports
      nitro.options.imports = mergeNitroImportsPreset(nitro.options.imports, {
        from: "@vitehub/chat/nitro",
        imports: ["defineChatWebhookHandler", "defineChatWebhookRegistryHandler"],
      }) as typeof nitro.options.imports
    }

    let runtimeFiles = await writeNitroChatRuntimeFiles(nitro, resolved)
    if (resolved) {
      installRoute(nitro, resolved, runtimeFiles.routeFile)
      await installCloudflareStateConfig(nitro, resolved, runtimeFiles.definitions)
    }

    nitro.hooks.hook("build:before", async () => {
      runtimeFiles = await writeNitroChatRuntimeFiles(nitro, resolved)
      if (resolved) {
        await installCloudflareStateConfig(nitro, resolved, runtimeFiles.definitions)
      }
    })
    nitro.hooks.hook("dev:reload", async () => {
      runtimeFiles = await writeNitroChatRuntimeFiles(nitro, resolved)
    })
  },
}

export default chatNitroModule

declare module "nitro/types" {
  interface NitroConfig {
    chat?: false | ChatModuleOptions
  }

  interface NitroOptions {
    chat?: false | ChatModuleOptions
    cloudflare?: Record<string, unknown> & {
      wrangler?: Record<string, unknown> & {
        name?: string
        durable_objects?: Record<string, unknown> & {
          bindings?: Array<{ class_name: string, name: string }>
        }
        migrations?: Array<{ new_sqlite_classes?: string[], tag: string }>
      }
    }
  }

  interface NitroRuntimeConfig {
    chat?: false | ResolvedChatModuleOptions
    hosting?: string
  }
}

declare module "@vitehub/chat" {
  interface ChatRuntimeConfig extends NitroRuntimeConfig {}
}
