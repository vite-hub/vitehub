import { rm } from "node:fs/promises"
import { resolve } from "node:path"

import { getViteMode } from "@vite-hub/internal/build/mode"
import {
  registerProviderRuntimeModules,
  shouldSkipViteProviderBuild,
  useComposedProviderOutput,
} from "@vite-hub/internal/build/deployment-output"
import { createNoExternalMerger, isServerEnvironment, resolveViteHubProjectRoot } from "@vite-hub/internal/build/vite"
import { writeFileIfChanged } from "@vite-hub/internal/definition-catalog"
import { getHostingProvider } from "@vite-hub/internal/hosting"
import { normalizePath } from "vite"

import { discoverRateLimitDeclarations } from "./discovery.ts"
import { writeRateLimitManifest } from "./internal/manifest.ts"
import { resolveRateLimitNamespace, writeRateLimitProviderOutput } from "./internal/provider-output.ts"

import type { ComposedProviderOutput } from "@vite-hub/internal/build/deployment-output"
import type { Plugin, ResolvedConfig } from "vite"
import type { RateLimitDeclaration, RateLimitModuleOptions, RateLimitRuntimeConfig } from "./types.ts"

const packageName = "@vite-hub/rate-limit"
const pluginName = "@vite-hub/rate-limit/vite"
const generatedNitroPlugin = ".vitehub/nitro/rate-limit/plugin.ts"
const generatedRuntimeModule = ".vitehub/rate-limit/cloudflare-runtime.mjs"
const legacyGeneratedRegistry = ".vitehub/nitro/rate-limit/registry.mjs"
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
  if (!plugins.includes(generatedNitroPlugin)) plugins.unshift(generatedNitroPlugin)
  return { ...nitro, plugins }
}

function renderRuntimeInstaller(
  runtimeConfig: RateLimitRuntimeConfig,
  importBase: string,
  nitro: boolean,
): string {
  return [
    ...(nitro ? ["import { definePlugin } from 'nitro'"] : []),
    `import { enterRateLimitRuntimeEvent, setRateLimitRuntimeConfig } from ${JSON.stringify(`${importBase}/runtime`)}`,
    "",
    `const config = ${JSON.stringify(runtimeConfig)}`,
    ...(nitro
      ? [
          "export default definePlugin((nitroApp) => {",
          "  setRateLimitRuntimeConfig(config)",
          "  nitroApp.hooks.hook('request', (event) => enterRateLimitRuntimeEvent(event))",
          "})",
        ]
      : [
          "setRateLimitRuntimeConfig(config)",
          "export default config",
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
  let declarations: RateLimitDeclaration[] = []
  let declarationFiles = new Set<string>()
  let previousDeclarations: RateLimitDeclaration[] = []
  let provider: "cloudflare" | "memory" = "memory"
  let projectRoot: string | undefined
  let resolved: ResolvedConfig | undefined

  const refreshDeclarations = async (): Promise<void> => {
    if (!projectRoot || !resolved) return
    declarations = discoverRateLimitDeclarations({
      rootDir: projectRoot,
      scanDirs: rateLimit.scanDirs,
    })
    declarationFiles = new Set(declarations.map(declaration => declaration.source.file))
    await writeRateLimitManifest(resolved.root, declarations, provider)
  }

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
      projectRoot = resolveViteHubProjectRoot(config.root, { projectRoot: rateLimit.projectRoot })
      provider = resolveProvider(rateLimit, config)
      await refreshDeclarations()
      const pluginFile = resolve(config.root, generatedNitroPlugin)
      const runtimeFile = resolve(config.root, generatedRuntimeModule)
      const runtimeConfig = { provider } satisfies RateLimitRuntimeConfig
      await Promise.all([
        rm(resolve(config.root, legacyGeneratedRegistry), { force: true }),
        writeFileIfChanged(pluginFile, renderRuntimeInstaller(runtimeConfig, importBase, true)),
        writeFileIfChanged(runtimeFile, renderRuntimeInstaller(runtimeConfig, importBase, false)),
      ])
      registerProviderRuntimeModules(composedOutput, "rate-limit", { cloudflare: runtimeFile })
    },
    configEnvironment(name, config) {
      if (!isServerEnvironment(name, config)) return
      return { resolve: { noExternal: mergeNoExternal(config.resolve?.noExternal) } }
    },
    async handleHotUpdate(context) {
      if (!/\.(?:c|m)?[jt]sx?$/i.test(context.file)) return
      resolved = context.server.config
      await refreshDeclarations()
    },
    transform(code, id) {
      if (provider !== "cloudflare" || !resolved?.build.ssr || !declarationFiles.has(id.split("?", 1)[0]!)) return
      return `import ${JSON.stringify(normalizePath(resolve(resolved.root, generatedRuntimeModule)))}\n${code}`
    },
    async closeBundle() {
      if (!resolved || shouldSkipViteProviderBuild(resolved.command, getViteMode())) return
      await refreshDeclarations()
      const namespace = resolveRateLimitNamespace(rateLimit.namespace)
      await writeRateLimitProviderOutput({
        clientOutDir: resolved.build.outDir,
        declarations,
        namespace,
        previousDeclarations,
        provider,
        rootDir: resolved.root,
      })
      previousDeclarations = declarations
    },
  }
}

declare module "vite" {
  interface UserConfig {
    rateLimit?: RateLimitModuleOptions
  }
}
