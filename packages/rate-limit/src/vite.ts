import { relative, resolve } from "node:path"

import { getViteMode } from "@vite-hub/internal/build/mode"
import {
  registerProviderRuntimeModules,
  shouldSkipViteProviderBuild,
  useComposedProviderOutput,
} from "@vite-hub/internal/build/deployment-output"
import { createRuntimeRegistryContents, writeFileIfChanged } from "@vite-hub/internal/definition-catalog"
import { getHostingProvider } from "@vite-hub/internal/hosting"
import { createNoExternalMerger, isServerEnvironment, resolveViteHubProjectRoot } from "@vite-hub/internal/build/vite"

import { discoverRateLimitDefinitions } from "./discovery.ts"
import { writeRateLimitManifest } from "./internal/manifest.ts"
import { writeRateLimitProviderOutput } from "./internal/provider-output.ts"

import type { ComposedProviderOutput } from "@vite-hub/internal/build/deployment-output"
import type { Plugin, ResolvedConfig } from "vite"
import type { DiscoveredRateLimitDefinition, RateLimitModuleOptions, RateLimitRuntimeConfig } from "./types.ts"

const packageName = "@vite-hub/rate-limit"
const pluginName = "@vite-hub/rate-limit/vite"
const generatedNitroPlugin = ".vitehub/nitro/rate-limit/plugin.ts"
const generatedRegistry = ".vitehub/nitro/rate-limit/registry.mjs"
const generatedRuntimeModule = ".vitehub/rate-limit/cloudflare-runtime.mjs"
const mergeNoExternal = createNoExternalMerger(packageName)

interface InternalRateLimitModuleOptions extends RateLimitModuleOptions {
  importBase?: string
}

export type RateLimitVitePluginOptions = RateLimitModuleOptions
export type RateLimitVitePlugin = Plugin

function cloneNitroConfig(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {}
}

function mergeNitroConfig(value: unknown): Record<string, unknown> {
  const nitro = cloneNitroConfig(value)
  const plugins = Array.isArray(nitro.plugins) ? [...nitro.plugins] : []
  if (!plugins.includes(generatedNitroPlugin)) plugins.push(generatedNitroPlugin)
  return { ...nitro, plugins }
}

function moduleImport(fromFile: string, targetFile: string): string {
  const path = relative(resolve(fromFile, ".."), targetFile).replace(/\\/g, "/")
  return path.startsWith(".") ? path : `./${path}`
}

function renderRuntimeInstaller(
  installerFile: string,
  registryFile: string,
  runtimeConfig: RateLimitRuntimeConfig,
  importBase: string,
  nitro: boolean,
): string {
  return [
    ...(nitro ? ["import { definePlugin } from 'nitro'"] : []),
    `import registry from ${JSON.stringify(moduleImport(installerFile, registryFile))}`,
    `import { enterRateLimitRuntimeEvent, setRateLimitRuntimeConfig, setRateLimitRuntimeRegistry } from ${JSON.stringify(`${importBase}/runtime`)}`,
    "",
    `const config = ${JSON.stringify(runtimeConfig)}`,
    ...(nitro
      ? [
          "export default definePlugin((nitroApp) => {",
          "  setRateLimitRuntimeConfig(config)",
          "  setRateLimitRuntimeRegistry(registry)",
          "  nitroApp.hooks.hook('request', (event) => enterRateLimitRuntimeEvent(event))",
          "})",
        ]
      : [
          "setRateLimitRuntimeConfig(config)",
          "setRateLimitRuntimeRegistry(registry)",
          "export default registry",
        ]),
    "",
  ].join("\n")
}

function resolveProvider(options: RateLimitModuleOptions, config: ResolvedConfig): "cloudflare" | "memory" {
  if (options.provider && options.provider !== "auto") return options.provider
  if (config.command === "serve") return "memory"
  const nitroPreset = (config as { nitro?: { preset?: string } }).nitro?.preset
  const hosting = getHostingProvider(nitroPreset || process.env.VITEHUB_HOSTING)
  if (hosting === "cloudflare") return "cloudflare"
  if (hosting) {
    throw new Error(`[vitehub] Rate Limit has no native ${hosting} driver. Configure a custom Rate Limiter instead of falling back to per-instance memory.`)
  }
  throw new Error("[vitehub] Rate Limit provider cannot be inferred for a production build. Set rateLimit.provider to \"cloudflare\" or explicitly choose \"memory\" for a known single-process deployment.")
}

export function hubRateLimit(options: RateLimitVitePluginOptions = {}): RateLimitVitePlugin {
  const importBase = (options as InternalRateLimitModuleOptions).importBase ?? packageName
  let rateLimit: RateLimitModuleOptions = options
  let composedOutput: ComposedProviderOutput | undefined
  let definitions: DiscoveredRateLimitDefinition[] = []
  let previousDefinitions: DiscoveredRateLimitDefinition[] = []
  let provider: "cloudflare" | "memory" = "memory"
  let resolved: ResolvedConfig | undefined

  return {
    name: pluginName,
    config(config) {
      rateLimit = config.rateLimit ?? rateLimit
      const nitro = mergeNitroConfig((config as { nitro?: unknown }).nitro)
      ;(config as { nitro?: unknown }).nitro = nitro
      return { nitro } as never
    },
    async configResolved(config) {
      resolved = config
      rateLimit = config.rateLimit ?? rateLimit
      composedOutput = useComposedProviderOutput(config)
      const projectRoot = resolveViteHubProjectRoot(config.root, { projectRoot: rateLimit.projectRoot })
      definitions = discoverRateLimitDefinitions({
        rootDir: projectRoot,
        scanDirs: rateLimit.scanDirs,
      })
      provider = resolveProvider(rateLimit, config)
      const registryFile = resolve(config.root, generatedRegistry)
      const pluginFile = resolve(config.root, generatedNitroPlugin)
      const runtimeFile = resolve(config.root, generatedRuntimeModule)
      const runtimeConfig = { provider } satisfies RateLimitRuntimeConfig
      await Promise.all([
        writeFileIfChanged(registryFile, createRuntimeRegistryContents(registryFile, definitions)),
        writeFileIfChanged(pluginFile, renderRuntimeInstaller(pluginFile, registryFile, runtimeConfig, importBase, true)),
        writeFileIfChanged(runtimeFile, renderRuntimeInstaller(runtimeFile, registryFile, runtimeConfig, importBase, false)),
        writeRateLimitManifest(config.root, definitions, provider),
      ])
      registerProviderRuntimeModules(composedOutput, "rate-limit", { cloudflare: runtimeFile })
    },
    configEnvironment(name, config) {
      if (!isServerEnvironment(name, config)) return
      return { resolve: { noExternal: mergeNoExternal(config.resolve?.noExternal) } }
    },
    async closeBundle() {
      if (!resolved || shouldSkipViteProviderBuild(resolved.command, getViteMode())) return
      await writeRateLimitProviderOutput({
        clientOutDir: resolved.build.outDir,
        definitions,
        previousDefinitions,
        provider,
        namespace: rateLimit.namespace,
        rootDir: resolved.root,
      })
      previousDefinitions = definitions
    },
  }
}

declare module "vite" {
  interface UserConfig {
    rateLimit?: RateLimitModuleOptions
  }
}
