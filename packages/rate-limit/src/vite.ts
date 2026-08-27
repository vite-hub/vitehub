import { resolve } from "node:path"

import { getViteMode } from "@vite-hub/internal/build/mode"
import {
  composeNitroCloudflareProviderOutput,
  contributeCloudflareProviderOutput,
  contributeProviderDeploymentOutput,
  contributeProviderRuntime,
  finalizeProviderDeploymentOutputs,
  resetProviderDeploymentOutputs,
  shouldSkipViteProviderBuild,
  useProviderOutputCatalog,
} from "@vite-hub/internal/build/deployment-output"
import { createNoExternalMerger, hasNitroConfigContext, isServerEnvironment, resolveViteHubProjectRoot } from "@vite-hub/internal/build/vite"
import { writeFileIfChanged } from "@vite-hub/internal/definition-catalog"
import { getHostingProvider } from "@vite-hub/internal/hosting"
import { normalizePath } from "vite"

import { discoverRateLimitCatalog } from "./discovery.ts"
import { writeRateLimitManifest } from "./internal/manifest.ts"
import { createCloudflareRateLimitBindings, resolveRateLimitNamespace, writeRateLimitProviderOutput } from "./internal/provider-output.ts"

import type { ProviderOutputCatalog } from "@vite-hub/internal/build/deployment-output"
import type { Plugin, ResolvedConfig } from "vite"
import type { RateLimitDeclaration, RateLimitModuleOptions, RateLimitRuntimeConfig } from "./types.ts"

const packageName = "@vite-hub/rate-limit"
const pluginName = "@vite-hub/rate-limit/vite"
const generatedNitroPlugin = ".vitehub/nitro/rate-limit/plugin.ts"
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

function mergeNitroConfig(
  config: object,
  value: unknown,
  declarations: RateLimitDeclaration[],
  namespace: string | undefined,
  provider: "cloudflare" | "memory" | undefined,
  nitroCloudflare: boolean,
): Record<string, unknown> {
  const providerOutput = useProviderOutputCatalog(config)
  const nitro = cloneNitroConfig(value)
  const plugins = Array.isArray(nitro.plugins) ? [...nitro.plugins] : []
  if (!plugins.includes(generatedNitroPlugin)) plugins.unshift(generatedNitroPlugin)
  const baseNitro = { ...nitro, plugins }
  if (!nitroCloudflare || provider !== "cloudflare" || declarations.length === 0) {
    contributeCloudflareProviderOutput(providerOutput, { owner: "rate-limit" })
    return composeNitroCloudflareProviderOutput(providerOutput, baseNitro, value)
  }
  if (!namespace) {
    throw new Error("[vitehub] Cloudflare Rate Limit requires rateLimit.namespace to isolate counters between deployments.")
  }
  contributeCloudflareProviderOutput(providerOutput, {
    owner: "rate-limit",
    rateLimits: createCloudflareRateLimitBindings(declarations, namespace),
  })
  return composeNitroCloudflareProviderOutput(providerOutput, baseNitro, value)
}

function renderRuntimeInstaller(
  runtimeConfig: RateLimitRuntimeConfig,
  importBase: string,
  nitro: boolean,
): string {
  return [
    ...(nitro ? ["import { definePlugin } from 'nitro'"] : []),
    `import { setRateLimitRuntimeConfig } from ${JSON.stringify(`${importBase}/runtime`)}`,
    "",
    `const config = ${JSON.stringify(runtimeConfig)}`,
    ...(nitro
      ? [
          "export default definePlugin(() => {",
          "  setRateLimitRuntimeConfig(config)",
          "})",
        ]
      : [
          "setRateLimitRuntimeConfig(config)",
          "export default config",
        ]),
    "",
  ].join("\n")
}

function resolveProvider(options: RateLimitModuleOptions, command: "build" | "serve", nitro: unknown, deferUnknown = false): "cloudflare" | "memory" | undefined {
  if (options.provider && options.provider !== "auto") return options.provider
  if (command === "serve") return "memory"
  const hosting = resolveNitroHosting(nitro)
  if (hosting === "cloudflare") return "cloudflare"
  if (hosting) {
    throw new Error(`[vitehub] Rate Limit has no native ${hosting} driver. Configure a custom Rate Limiter instead of falling back to per-instance memory.`)
  }
  if (deferUnknown) return
  throw new Error("[vitehub] Rate Limit provider cannot be inferred for a production build. Set rateLimit.provider to \"cloudflare\" or explicitly choose \"memory\" for a known single-process deployment.")
}

function resolveNitroHosting(nitro: unknown): string | undefined {
  const preset = cloneNitroConfig(nitro).preset
  return getHostingProvider(typeof preset === "string" ? preset : process.env.NITRO_PRESET || process.env.SERVER_PRESET || process.env.VITEHUB_HOSTING)
}

export function hubRateLimit(options: RateLimitVitePluginOptions = {}): RateLimitVitePlugin {
  const importBase = (options as InternalRateLimitModuleOptions).importBase ?? packageName
  let rateLimit: RateLimitModuleOptions = options
  let composedOutput: ProviderOutputCatalog | undefined
  let declarations: RateLimitDeclaration[] = []
  let declarationFiles = new Set<string>()
  let cloudflareOwnedByNitro = false
  let previousDeclarations: RateLimitDeclaration[] = []
  let provider: "cloudflare" | "memory" = "memory"
  let projectRoot: string | undefined
  let resolved: ResolvedConfig | undefined

  const collectDeclarations = (): void => {
    if (!projectRoot) return
    const catalog = discoverRateLimitCatalog({
      rootDir: projectRoot,
      scanDirs: rateLimit.scanDirs,
    })
    declarations = catalog.declarations
    declarationFiles = catalog.declarationFiles
  }

  const refreshDeclarations = async (): Promise<void> => {
    if (!projectRoot || !resolved) return
    collectDeclarations()
    await writeRateLimitManifest(resolved.root, declarations, provider)
  }

  return {
    name: pluginName,
    config(config, env) {
      rateLimit = config.rateLimit ?? rateLimit
      const configuredNitro = (config as { nitro?: unknown }).nitro
      projectRoot = resolveViteHubProjectRoot(config.root || process.cwd(), { projectRoot: rateLimit.projectRoot })
      const configuredProvider = resolveProvider(rateLimit, env?.command ?? "serve", configuredNitro, true)
      if (configuredProvider) provider = configuredProvider
      collectDeclarations()
      const nitro = mergeNitroConfig(
        config,
        configuredNitro,
        declarations,
        resolveRateLimitNamespace(rateLimit.namespace),
        configuredProvider,
        resolveNitroHosting(configuredNitro) === "cloudflare",
      )
      ;(config as { nitro?: unknown }).nitro = nitro
    },
    async configResolved(config) {
      resolved = config
      rateLimit = config.rateLimit ?? rateLimit
      composedOutput = useProviderOutputCatalog(config)
      projectRoot = resolveViteHubProjectRoot(config.root, { projectRoot: rateLimit.projectRoot })
      const configuredNitro = (config as { nitro?: unknown }).nitro
      const nitroCloudflare = resolveNitroHosting(configuredNitro) === "cloudflare"
      cloudflareOwnedByNitro = hasNitroConfigContext(config) && nitroCloudflare
      provider = resolveProvider(rateLimit, config.command, configuredNitro)!
      collectDeclarations()
      ;(config as { nitro?: unknown }).nitro = mergeNitroConfig(
        config,
        configuredNitro,
        declarations,
        resolveRateLimitNamespace(rateLimit.namespace),
        provider,
        nitroCloudflare,
      )
      await writeRateLimitManifest(config.root, declarations, provider)
      const pluginFile = resolve(config.root, generatedNitroPlugin)
      const runtimeFile = resolve(config.root, generatedRuntimeModule)
      const runtimeConfig = { provider } satisfies RateLimitRuntimeConfig
      await Promise.all([
        writeFileIfChanged(pluginFile, renderRuntimeInstaller(runtimeConfig, importBase, true)),
        writeFileIfChanged(runtimeFile, renderRuntimeInstaller(runtimeConfig, importBase, false)),
      ])
      contributeProviderRuntime(composedOutput, { owner: "rate-limit", runtimeModules: { cloudflare: runtimeFile } })
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
    async buildEnd(error) {
      if (error) {
        await resetProviderDeploymentOutputs(composedOutput)
        return
      }
      if (!resolved || shouldSkipViteProviderBuild(resolved.command, getViteMode())) return
      try {
        if (cloudflareOwnedByNitro && provider === "cloudflare") {
          const configuredDeclarations = declarations
          collectDeclarations()
          if (JSON.stringify(declarations) !== JSON.stringify(configuredDeclarations)) {
            throw new Error("[vitehub] Nitro Cloudflare Rate Limit declarations changed after config resolution. Generate Rate Limit source files before Vite config resolves.")
          }
          await writeRateLimitManifest(resolved.root, declarations, provider)
        }
        else {
          await refreshDeclarations()
        }
        const namespace = resolveRateLimitNamespace(rateLimit.namespace)
        const config = resolved
        contributeProviderDeploymentOutput(composedOutput, {
          owner: "rate-limit",
          rootDir: config.root,
          write: async ({ write }) => {
            await writeRateLimitProviderOutput({
              clientOutDir: config.build.outDir,
              cloudflareOwnedByNitro,
              declarations,
              namespace,
              previousDeclarations,
              provider,
              rootDir: config.root,
            }, write)
            previousDeclarations = declarations
          },
        })
      }
      catch (error) {
        await resetProviderDeploymentOutputs(composedOutput)
        throw error
      }
    },
    closeBundle: {
      order: "post",
      async handler() {
        if (!resolved || shouldSkipViteProviderBuild(resolved.command, getViteMode())) return
        await finalizeProviderDeploymentOutputs(composedOutput)
      },
    },
  }
}

declare module "vite" {
  interface UserConfig {
    rateLimit?: RateLimitModuleOptions
  }
}
