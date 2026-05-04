import { createImportPath } from "@vitehub/internal/build/paths"
import { createGeneratedDefinitionPath, createRuntimeRegistryContents, writeFileIfChanged } from "@vitehub/internal/definition-catalog"
import { mergeNitroImportsPreset, resolveRuntimeEntry as resolveEntry } from "@vitehub/internal/nitro"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import { defaultChatCloudflareDurableObjectName, defaultChatCloudflareDurableObjectState, normalizeChatOptions } from "../config.ts"
import { discoverChatDefinitions } from "../discovery.ts"
import { configureCloudflareChatState, discoverCloudflareChatStateConfig } from "../integrations/cloudflare.ts"

import type { Nitro, NitroModule, NitroRuntimeConfig } from "nitro/types"
import type { ChatModuleOptions, DiscoveredChatDefinition, ResolvedChatModuleOptions } from "../types.ts"

const CHAT_NITRO_IMPORTS_PRESET = {
  from: "@vitehub/chat",
  imports: ["defineChat"],
}
const chatCloudflareExportsModulePrefix = "virtual:vitehub-chat-cloudflare-exports"

interface RollupPluginLike {
  name: string
  buildStart?: (this: { emitFile: (file: { fileName: string, id: string, type: "chunk" }) => void }) => void
  load?: (id: string) => string | undefined
  renderChunk?: (code: string, chunk: { fileName: string, isEntry?: boolean }) => { code: string, map: null } | null | undefined
  resolveId?: (id: string) => string | undefined
}

function resolveRuntimeEntry(srcRelative: string, packageSubpath: string): string {
  return resolveEntry(srcRelative, packageSubpath, import.meta.url)
}

function createCloudflareChatExportsRollupPlugin(className: string): RollupPluginLike {
  const moduleId = `${chatCloudflareExportsModulePrefix}:${className}`
  const resolvedModuleId = `\0${moduleId}`
  const fileName = `chat-cloudflare-exports-${className}.mjs`
  const exportName = className === "ChatStateDO" ? "ChatStateDO" : `ChatStateDO as ${className}`

  return {
    name: "vitehub-chat-cloudflare-exports",
    buildStart() {
      this.emitFile({
        type: "chunk",
        id: moduleId,
        fileName,
      })
    },
    load(id) {
      if (id === resolvedModuleId) {
        return [
          `export { ${exportName} } from "chat-state-cloudflare-do"`,
          "",
        ].join("\n")
      }
    },
    renderChunk(code, chunk) {
      if (!chunk.isEntry || chunk.fileName !== "index.mjs") {
        return null
      }

      return {
        code: `${code}\nexport { ${className} } from "./${fileName}"\n`,
        map: null,
      }
    },
    resolveId(id) {
      if (id === moduleId) {
        return resolvedModuleId
      }
    },
  }
}

function installCloudflareChatEntrypoint(nitro: Nitro, className: string): void {
  const options = nitro.options as Nitro["options"] & {
    rollupConfig?: {
      plugins?: unknown[]
    }
  }
  options.rollupConfig ||= {}
  const plugins = Array.isArray(options.rollupConfig.plugins) ? options.rollupConfig.plugins : []
  options.rollupConfig.plugins = plugins
  if (plugins.some(plugin => typeof plugin === "object" && plugin !== null && "name" in plugin && (plugin as { name?: string }).name === `vitehub-chat-cloudflare-exports:${className}`)) {
    return
  }

  const plugin = createCloudflareChatExportsRollupPlugin(className)
  plugin.name = `vitehub-chat-cloudflare-exports:${className}`
  plugins.push(plugin)
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

function createNitroChatDevInitializerPath(rootDir: string, buildDir: string): string {
  return createGeneratedDefinitionPath(rootDir, {
    buildDir,
    fileName: "dev-initialize.mjs",
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

function toCloudflareWorkerName(name: string): string {
  return name.toLowerCase().replace(/[^a-zA-Z0-9-]/g, "-").replace(/^-+|-+$/g, "")
}

async function resolveCloudflareDurableObjectStateName(nitro: Nitro, configuredName?: string): Promise<string> {
  if (configuredName) {
    return configuredName
  }

  return await readPackageName(nitro.options.rootDir) || defaultChatCloudflareDurableObjectName
}

async function installCloudflareWorkerName(nitro: Nitro, options: ResolvedChatModuleOptions): Promise<void> {
  if (resolveChatProvider(nitro, options) !== "cloudflare") {
    return
  }

  const cloudflare = (nitro.options.cloudflare ||= {}) as Record<string, unknown> & {
    wrangler?: Record<string, unknown> & { name?: unknown }
  }
  cloudflare.wrangler ||= {}
  if (typeof cloudflare.wrangler.name === "string" && cloudflare.wrangler.name.trim()) {
    return
  }

  const name = await readPackageName(nitro.options.rootDir)
  if (name) {
    cloudflare.wrangler.name = toCloudflareWorkerName(name)
  }
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

function createNitroSingleChatDevInitializerContents(file: string, definition: DiscoveredChatDefinition): string {
  return [
    `import chat from ${JSON.stringify(createImportPath(file, definition.handler))}`,
    `import { defineChatDevInitializer } from "@vitehub/chat/nitro"`,
    "",
    `export default defineChatDevInitializer(chat, ${renderOptions({
      inferredName: definition.name,
    })})`,
    "",
  ].join("\n")
}

function createNitroRegistryChatDevInitializerContents(file: string, registryFile: string): string {
  return [
    `import chatRegistry from ${JSON.stringify(createImportPath(file, registryFile))}`,
    `import { defineChatDevRegistryInitializer } from "@vitehub/chat/nitro"`,
    "",
    `export default defineChatDevRegistryInitializer(chatRegistry)`,
    "",
  ].join("\n")
}

interface ChatRuntimeFiles {
  devInitializerFile?: string
  definitions: DiscoveredChatDefinition[]
  registryFile?: string
  routeFile?: string
}

async function writeNitroChatRuntimeFiles(nitro: Nitro, options: false | ResolvedChatModuleOptions): Promise<ChatRuntimeFiles> {
  const definitions = discoverChatDefinitions({
    mode: "nitro-server-chats",
    scanDirs: resolveNitroChatScanDirs(nitro.options.rootDir, nitro.options.scanDirs),
  })

  if (!options || !definitions.length) {
    return { definitions }
  }

  const hasChatParam = options.webhook ? routeHasParam(options.webhook.route, options.webhook.chatParam) : false
  if (definitions.length > 1 && options.webhook && !hasChatParam) {
    throw new Error(`Multiple chat definitions were discovered, but chat.webhook.route does not include [${options.webhook.chatParam}]. Use a route such as /api/webhooks/[${options.webhook.chatParam}]/[${options.webhook.routeParam}].`)
  }

  let registryFile: string | undefined
  if (definitions.length > 1 || hasChatParam) {
    registryFile = createNitroChatRegistryPath(nitro.options.rootDir, nitro.options.buildDir)
    await writeFileIfChanged(registryFile, createRuntimeRegistryContents(registryFile, definitions))
  }

  let routeFile: string | undefined
  if (options.webhook) {
    routeFile = createNitroChatRoutePath(nitro.options.rootDir, nitro.options.buildDir)
  }

  if (routeFile && options.webhook && hasChatParam && registryFile) {
    await writeFileIfChanged(routeFile, createNitroRegistryChatRouteContents(routeFile, registryFile, options))
  }
  else if (routeFile && options.webhook) {
    await writeFileIfChanged(routeFile, createNitroSingleChatRouteContents(routeFile, definitions[0]!, options))
  }

  let devInitializerFile: string | undefined
  if (options.dev && options.dev.initialize) {
    devInitializerFile = createNitroChatDevInitializerPath(nitro.options.rootDir, nitro.options.buildDir)
    if (definitions.length > 1 && registryFile) {
      await writeFileIfChanged(devInitializerFile, createNitroRegistryChatDevInitializerContents(devInitializerFile, registryFile))
    }
    else {
      await writeFileIfChanged(devInitializerFile, createNitroSingleChatDevInitializerContents(devInitializerFile, definitions[0]!))
    }
  }

  return { definitions, devInitializerFile, registryFile, routeFile }
}

function installAliases(nitro: Nitro): void {
  nitro.options.alias ||= {}
  nitro.options.alias["@vitehub/chat"] = resolveRuntimeEntry("../index", "@vitehub/chat")
  nitro.options.alias["@vitehub/chat/cloudflare"] = resolveRuntimeEntry("../cloudflare", "@vitehub/chat/cloudflare")
  nitro.options.alias["@vitehub/chat/nitro"] = resolveRuntimeEntry("../nitro", "@vitehub/chat/nitro")
  nitro.options.alias["@vitehub/chat/runtime/nitro-runtime-config"] = resolveRuntimeEntry("../runtime/nitro-runtime-config", "@vitehub/chat/runtime/nitro-runtime-config")
  nitro.options.alias["@vitehub/chat/runtime/nitro-plugin"] = resolveRuntimeEntry("../runtime/nitro-plugin", "@vitehub/chat/runtime/nitro-plugin")
  nitro.options.alias["@vitehub/chat/vercel"] = resolveRuntimeEntry("../vercel", "@vitehub/chat/vercel")
  nitro.options.alias["@vitehub/chat/runtime/nitro-dev-initialize"] = resolveRuntimeEntry("../runtime/nitro-dev-initialize", "@vitehub/chat/runtime/nitro-dev-initialize")
}

function installDevInitializerAlias(nitro: Nitro, devInitializerFile: string | undefined): void {
  nitro.options.alias ||= {}
  nitro.options.alias["@vitehub/chat/runtime/nitro-dev-initialize"] = devInitializerFile || resolveRuntimeEntry("../runtime/nitro-dev-initialize", "@vitehub/chat/runtime/nitro-dev-initialize")
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

async function writeNitroTypes(nitro: Nitro): Promise<string> {
  const dtsPath = resolve(nitro.options.rootDir, nitro.options.buildDir, "types", "vitehub-chat.d.ts")
  await writeFileIfChanged(dtsPath, [
    `import "@vitehub/chat/nitro"`,
    "",
    "export {}",
    "",
  ].join("\n"))
  return dtsPath
}

async function installNitroTypes(nitro: Nitro): Promise<void> {
  await writeNitroTypes(nitro)
  nitro.hooks.hook("types:extend", async (types: { tsConfig?: { include?: string[] } }) => {
    const dtsPath = await writeNitroTypes(nitro)
    if (types.tsConfig) {
      types.tsConfig.include ||= []
      types.tsConfig.include.push(dtsPath)
    }
  })
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
    installCloudflareChatEntrypoint(nitro, config.className)

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
    ...defaultChatCloudflareDurableObjectState,
    name,
  })

  for (const config of await discoverCloudflareChatStateConfig(definitions)) {
    configureCloudflareChatState(nitro.options, {
      binding: config.binding,
      className: config.className,
      migrationTag: config.migrationTag,
    })
    installCloudflareChatEntrypoint(nitro, config.className)
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
    await installNitroTypes(nitro)

    const importsExplicitlyDisabled = nitro.options._config?.imports === false || (resolved && !resolved.imports)
    if (!importsExplicitlyDisabled) {
      nitro.options.imports = mergeNitroImportsPreset(nitro.options.imports === false ? {} : nitro.options.imports, CHAT_NITRO_IMPORTS_PRESET) as typeof nitro.options.imports
      nitro.options.imports = mergeNitroImportsPreset(nitro.options.imports, {
        from: "@vitehub/chat/nitro",
        imports: ["defineChatDevInitializer", "defineChatDevRegistryInitializer", "defineChatWebhookHandler", "defineChatWebhookRegistryHandler"],
      }) as typeof nitro.options.imports
    }

    let runtimeFiles = await writeNitroChatRuntimeFiles(nitro, resolved)
    installDevInitializerAlias(nitro, runtimeFiles.devInitializerFile)
    if (resolved) {
      installRoute(nitro, resolved, runtimeFiles.routeFile)
      await installCloudflareWorkerName(nitro, resolved)
      await installCloudflareStateConfig(nitro, resolved, runtimeFiles.definitions)
    }

    nitro.hooks.hook("build:before", async () => {
      runtimeFiles = await writeNitroChatRuntimeFiles(nitro, resolved)
      installDevInitializerAlias(nitro, runtimeFiles.devInitializerFile)
      if (resolved) {
        installRoute(nitro, resolved, runtimeFiles.routeFile)
        await installCloudflareWorkerName(nitro, resolved)
        await installCloudflareStateConfig(nitro, resolved, runtimeFiles.definitions)
      }
    })
    nitro.hooks.hook("dev:reload", async () => {
      runtimeFiles = await writeNitroChatRuntimeFiles(nitro, resolved)
      installDevInitializerAlias(nitro, runtimeFiles.devInitializerFile)
      if (resolved) {
        installRoute(nitro, resolved, runtimeFiles.routeFile)
      }
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
