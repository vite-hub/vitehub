import { resolve } from "node:path"

import { createImportPath } from "@vitehub/internal/build/paths"
import { createGeneratedDefinitionPath, writeFileIfChanged } from "@vitehub/internal/definition-catalog"
import { mergeNitroImportsPreset, resolveRuntimeEntry as resolveEntry } from "@vitehub/internal/nitro"

import { normalizeChatOptions } from "../config.ts"
import { configureCloudflareChatState, installCloudflareChatStateEntrypoint } from "../integrations/cloudflare.ts"

import type { Nitro, NitroModule, NitroRuntimeConfig } from "nitro/types"
import type { ChatModuleOptions, ResolvedChatModuleOptions } from "../types.ts"

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

function normalizeNitroRoute(route: string): string {
  return route.replace(/\[([A-Za-z0-9_]+)\]/g, ":$1")
}

function createNitroChatRouteContents(file: string, entry: string): string {
  return [
    `import chat from ${JSON.stringify(createImportPath(file, entry))}`,
    `import { defineChatWebhookHandler } from "@vitehub/chat/nitro"`,
    "",
    "export default defineChatWebhookHandler(chat)",
    "",
  ].join("\n")
}

async function writeNitroChatRuntimeFiles(nitro: Nitro, options: false | ResolvedChatModuleOptions): Promise<{ routeFile?: string }> {
  if (!options || !options.entry || !options.route) {
    return {}
  }

  const routeFile = createNitroChatRoutePath(nitro.options.rootDir, nitro.options.buildDir)
  const entry = resolve(nitro.options.rootDir, options.entry)
  await writeFileIfChanged(routeFile, createNitroChatRouteContents(routeFile, entry))
  return { routeFile }
}

function installAliases(nitro: Nitro): void {
  nitro.options.alias ||= {}
  nitro.options.alias["@vitehub/chat"] = resolveRuntimeEntry("../index", "@vitehub/chat")
  nitro.options.alias["@vitehub/chat/cloudflare"] = resolveRuntimeEntry("../cloudflare", "@vitehub/chat/cloudflare")
  nitro.options.alias["@vitehub/chat/nitro"] = resolveRuntimeEntry("../nitro", "@vitehub/chat/nitro")
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

function installRoute(nitro: Nitro, options: ResolvedChatModuleOptions, routeFile: string | undefined): void {
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

const chatNitroModule: NitroModule = {
  name: "@vitehub/chat",
  async setup(nitro) {
    const resolved = normalizeChatOptions((nitro.options as typeof nitro.options & { chat?: false | ChatModuleOptions }).chat)
    const runtimeConfig = (nitro.options.runtimeConfig ||= {} as NitroRuntimeConfig)
    if (nitro.options.preset) runtimeConfig.hosting ||= nitro.options.preset
    runtimeConfig.chat = resolved || false

    installAliases(nitro)
    installNitroPlugin(nitro)

    const importsExplicitlyDisabled = nitro.options._config?.imports === false || (resolved && !resolved.imports)
    if (!importsExplicitlyDisabled) {
      nitro.options.imports = mergeNitroImportsPreset(nitro.options.imports === false ? {} : nitro.options.imports, CHAT_NITRO_IMPORTS_PRESET) as typeof nitro.options.imports
      nitro.options.imports = mergeNitroImportsPreset(nitro.options.imports, {
        from: "@vitehub/chat/nitro",
        imports: ["defineChatWebhookHandler"],
      }) as typeof nitro.options.imports
    }

    let runtimeFiles = await writeNitroChatRuntimeFiles(nitro, resolved)
    if (resolved) {
      installRoute(nitro, resolved, runtimeFiles.routeFile)
    }

    const durableObjectState = resolved && resolved.cloudflare?.durableObjectState
    if (durableObjectState && durableObjectState.autoWrangler) {
      configureCloudflareChatState(nitro.options, durableObjectState)
      installCloudflareChatStateEntrypoint(nitro, durableObjectState.className)
    }

    nitro.hooks.hook("build:before", async () => {
      runtimeFiles = await writeNitroChatRuntimeFiles(nitro, resolved)
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
    cloudflare?: {
      wrangler?: {
        durable_objects?: {
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
