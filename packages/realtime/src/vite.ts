import { mkdir, writeFile } from "node:fs/promises"
import { dirname, relative, resolve } from "node:path"

import { createRuntimeRegistryContents } from "@vite-hub/internal/definition-catalog"
import { deploymentPresetFromNitro } from "@vite-hub/internal/deployment"
import { VITEHUB_SERVER_DIRS, resolveViteHubProjectRoot } from "@vite-hub/internal/build/vite"
import { getHostingProvider } from "@vite-hub/internal/hosting"

import { discoverRealtimeDefinitions } from "./discovery.ts"

import type { Plugin, UserConfig } from "vite"
import type { RealtimeModuleOptions } from "./types.ts"

export interface RealtimeVitePluginOptions extends RealtimeModuleOptions {
  importBase?: string
}

interface NitroConfig extends Record<string, unknown> {
  cloudflare?: Record<string, unknown>
  features?: Record<string, unknown>
  handlers?: Array<Record<string, unknown>>
  preset?: string
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {}
}

function configureCloudflareRealtime(nitro: NitroConfig): void {
  nitro.preset = "cloudflare-durable"
  const cloudflare = record(nitro.cloudflare)
  const wrangler = record(cloudflare.wrangler)
  const durableObjects = record(wrangler.durable_objects)
  const bindings = Array.isArray(durableObjects.bindings) ? durableObjects.bindings : []
  if (!bindings.some(binding => record(binding).name === "$DurableObject")) {
    durableObjects.bindings = [...bindings, { class_name: "$DurableObject", name: "$DurableObject" }]
  }
  const migrations = Array.isArray(wrangler.migrations) ? wrangler.migrations : []
  if (!migrations.some(migration => record(migration).tag === "vitehub-realtime-v1")) {
    wrangler.migrations = [
      ...migrations,
      { new_sqlite_classes: ["$DurableObject"], tag: "vitehub-realtime-v1" },
    ]
  }
  wrangler.durable_objects = durableObjects
  cloudflare.wrangler = wrangler
  nitro.cloudflare = cloudflare
}

function moduleSpecifier(from: string, to: string): string {
  const value = relative(dirname(from), to).replaceAll("\\", "/")
  return value.startsWith(".") ? value : `./${value}`
}

export function hubRealtime(options: RealtimeVitePluginOptions = {}): Plugin {
  const importBase = options.importBase ?? "@vite-hub/realtime"
  return {
    name: "@vite-hub/realtime/vite",
    enforce: "pre",
    async config(config, environment) {
      const root = resolveViteHubProjectRoot(resolve(config.root || process.cwd()), options)
      const serverDirs = (config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS]
      const definitions = discoverRealtimeDefinitions(root, serverDirs)
      if (definitions.length === 0) return

      config.resolve = {
        ...config.resolve,
        dedupe: [...new Set([...(config.resolve?.dedupe || []), "yjs"])],
      }
      config.define = {
        __VITEHUB_APP_BASE_URL__: JSON.stringify(config.base || "/"),
        ...config.define,
      }

      const directory = resolve(root, ".vitehub/nitro/realtime")
      const registryFile = resolve(directory, "registry.mjs")
      const handlerFile = resolve(directory, "handler.ts")
      await mkdir(directory, { recursive: true })
      await Promise.all([
        writeFile(registryFile, createRuntimeRegistryContents(registryFile, definitions)),
        writeFile(handlerFile, [
          `import registry from ${JSON.stringify(moduleSpecifier(handlerFile, registryFile))}`,
          `import { createRealtimeHandler } from ${JSON.stringify(`${importBase}/server`)}`,
          "",
          "export default createRealtimeHandler(registry)",
          "",
        ].join("\n")),
      ])

      const nitro = { ...((config as { nitro?: NitroConfig }).nitro || {}) }
      const configuredPreset = nitro.preset || process.env.NITRO_PRESET || process.env.SERVER_PRESET || process.env.VITEHUB_HOSTING
      const deploymentPreset = deploymentPresetFromNitro(configuredPreset)
      const provider = getHostingProvider(configuredPreset)
      const authority = options.authority || "auto"
      if (authority === "cloudflare" && deploymentPreset && deploymentPreset !== "cloudflare") {
        throw new Error(`[vitehub] Realtime authority "cloudflare" conflicts with the ${deploymentPreset} deployment preset.`)
      }
      if (authority === "cloudflare" || (authority === "auto" && provider === "cloudflare")) {
        configureCloudflareRealtime(nitro)
      }
      else if (environment?.command === "build" && authority === "auto") {
        throw new Error("[vitehub] Realtime production builds require one room authority. Deploy to Cloudflare Durable Objects or explicitly set realtime.authority to \"memory\" for a single-process server.")
      }
      else if (authority === "memory" && provider) {
        throw new Error(`[vitehub] Realtime authority "memory" is single-process only and cannot use the ${provider} deployment preset.`)
      }
      nitro.features = { ...nitro.features, websocket: true }
      nitro.handlers = [
        ...(nitro.handlers || []),
        { handler: handlerFile, route: "/api/_vitehub/realtime/**" },
      ]
      ;(config as UserConfig & { nitro?: NitroConfig }).nitro = nitro
    },
  }
}
