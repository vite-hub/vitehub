import * as v from "valibot"
import { randomUUID } from "node:crypto"
import { resolve } from "node:path"

import { getViteMode } from "@vite-hub/internal/build/mode"
import {
  composeNitroCloudflareProviderOutput,
  contributeCloudflareProviderOutput,
  contributeProviderDeploymentOutput,
  contributeProviderRuntime,
  createProviderDeploymentOutputGenerationState,
  finalizeProviderDeploymentOutputs,
  shouldSkipViteProviderBuild,
  useProviderOutputCatalog,
} from "@vite-hub/internal/build/deployment-output"
import { createNoExternalAddition, hasNitroConfigContext, isServerEnvironment, resolveViteHubProjectRoot } from "@vite-hub/internal/build/vite"
import { renderViteHubNitroDevHandler } from "@vite-hub/internal/dev-endpoint"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"
import { writeFileIfChanged } from "@vite-hub/internal/definition-catalog"
import { getHostingProvider } from "@vite-hub/internal/hosting"
import { normalizePath } from "vite"

import { rateLimitDevRuntimeRoute } from "./dev.ts"
import { discoverRateLimitCatalog } from "./discovery.ts"
import { inspectRateLimitDefinitions } from "./inspect.ts"
import { writeRateLimitManifest } from "./internal/manifest.ts"
import { createCloudflareRateLimitBindings, resolveRateLimitNamespace, writeRateLimitProviderOutput } from "./internal/provider-output.ts"
import { registerRateLimitDevEndpoint } from "./vite-dev.ts"

import type { ProviderOutputCatalog } from "@vite-hub/internal/build/deployment-output"
import type { ViteHubCliPluginMetadata } from "@vite-hub/internal/cli"
import type { ViteHubInspectionPluginMetadata } from "@vite-hub/internal/inspect"
import type { Plugin, ResolvedConfig, UserConfig } from "vite"
import type { RateLimitDeclaration, RateLimitModuleOptions, RateLimitRuntimeConfig } from "./types.ts"
import { rateLimitErrorDiagnostics } from "./error-diagnostics.ts"

export { discoverRateLimitDeclarations } from "./discovery.ts"
export { inspectRateLimitDefinitions, type RateLimitInspectionOptions, rateLimitConsoleSection } from "./inspect.ts"

const packageName = "@vite-hub/rate-limit"
const pluginName = "@vite-hub/rate-limit/vite"
const generatedNitroPlugin = ".vitehub/nitro/rate-limit/plugin.ts"
const generatedRuntimeModule = ".vitehub/rate-limit/cloudflare-runtime.mjs"
const generatedNitroDevHandler = ".vitehub/nitro/rate-limit/dev-handler.ts"
const mergeNoExternal = createNoExternalAddition(packageName)

interface InternalRateLimitModuleOptions extends RateLimitModuleOptions {
  importBase?: string
}

export type RateLimitVitePluginOptions = RateLimitModuleOptions
export type RateLimitVitePlugin = Plugin & { vitehub: ViteHubCliPluginMetadata & ViteHubInspectionPluginMetadata }
type RateLimitConfig = UserConfig | ResolvedConfig

function cloneNitroConfig(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {}
}

function mergeNitroConfig(
  config: RateLimitConfig,
  value: unknown,
  declarations: RateLimitDeclaration[],
  namespace: string | undefined,
  provider: "cloudflare" | "memory" | undefined,
  nitroCloudflare: boolean,
  devHandler: string | undefined,
  projectRoot: string,
): Record<string, unknown> {
  const providerOutput = useProviderOutputCatalog(config)
  const nitro = cloneNitroConfig(value)
  const kit = createNitroServerKit(nitro)
  kit.addPlugin(resolve(projectRoot, generatedNitroPlugin), "start")
  // The dev handler runs `vitehub rate-limit` operations in the Nitro runtime. Build output never contains it.
  if (devHandler) kit.addHandler({ handler: devHandler, route: rateLimitDevRuntimeRoute })
  const baseNitro = kit.config
  if (!nitroCloudflare || provider !== "cloudflare" || declarations.length === 0) {
    contributeCloudflareProviderOutput(providerOutput, { owner: "rate-limit" })
    return composeNitroCloudflareProviderOutput(providerOutput, baseNitro, value)
  }
  if (!namespace) {
    throw rateLimitErrorDiagnostics.RATE_LIMIT_B0001({ message: "[vitehub] Cloudflare Rate Limit requires rateLimit.namespace to isolate counters between deployments." })
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
    throw rateLimitErrorDiagnostics.RATE_LIMIT_B0002({ message: `[vitehub] Rate Limit has no native ${hosting} driver. Configure a custom Rate Limiter instead of falling back to per-instance memory.` })
  }
  if (deferUnknown) return
  throw rateLimitErrorDiagnostics.RATE_LIMIT_B0003({ message: "[vitehub] Rate Limit provider cannot be inferred for a production build. Set rateLimit.provider to \"cloudflare\" or explicitly choose \"memory\" for a known single-process deployment." })
}

function resolveNitroHosting(nitro: unknown): string | undefined {
  const preset = cloneNitroConfig(nitro).preset
  return getHostingProvider(typeof preset === "string" ? preset : process.env.NITRO_PRESET || process.env.SERVER_PRESET || process.env.VITEHUB_HOSTING)
}

export function hubRateLimit(options: RateLimitVitePluginOptions = {}): RateLimitVitePlugin {
  const importBase = (options as InternalRateLimitModuleOptions).importBase ?? packageName
  const runtimeToken = randomUUID()
  let rateLimit: RateLimitModuleOptions = options
  let composedOutput: ProviderOutputCatalog | undefined
  const providerOutputGenerations = createProviderDeploymentOutputGenerationState()
  let declarations: RateLimitDeclaration[] = []
  let declarationFiles = new Set<string>()
  let cloudflareOwnedByNitro = false
  let previousDeclarations: RateLimitDeclaration[] = []
  let provider: "cloudflare" | "memory" = "memory"
  let projectRoot: string | undefined
  let resolved: ResolvedConfig | undefined
  let devHandler: string | undefined

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
    await writeRateLimitManifest(projectRoot, declarations, provider)
  }

  const inspectionRoot = (): string => projectRoot ?? resolveViteHubProjectRoot(process.cwd(), { projectRoot: rateLimit.projectRoot })

  return {
    name: pluginName,
    vitehub: {
      cli: async () => {
        const { createRateLimitCliContributor } = await import(/* @vite-ignore */ "./cli.js")
        return createRateLimitCliContributor()
      },
      inspect: () => ({
        definitions: [{
          kind: "rate-limit",
          label: "Rate Limits",
          list: () => inspectRateLimitDefinitions({ projectRoot: inspectionRoot(), rootDir: inspectionRoot(), scanDirs: rateLimit.scanDirs }),
        }],
        providerOutput: [{
          description: "Rate Limit manifest with provider and capabilities",
          owner: "rate-limit",
          path: resolve(inspectionRoot(), ".vitehub/rate-limit/manifest.json"),
        }],
      }),
    },
    config(config, env) {
      const cliDiscovery = "vitehubCliDiscovery" in config && config.vitehubCliDiscovery === true
      rateLimit = config.rateLimit ?? rateLimit
      const configuredNitro = (config as { nitro?: unknown }).nitro
      projectRoot = resolveViteHubProjectRoot(config.root || process.cwd(), { projectRoot: rateLimit.projectRoot })
      const configuredProvider = resolveProvider(rateLimit, env?.command ?? "serve", configuredNitro, true)
      if (configuredProvider) provider = configuredProvider
      collectDeclarations()
      // `configResolved` writes this file before the Development Server starts Nitro.
      if (env?.command === "serve" && !cliDiscovery) devHandler = resolve(projectRoot, generatedNitroDevHandler)
      const nitro = mergeNitroConfig(
        config,
        configuredNitro,
        declarations,
        resolveRateLimitNamespace(rateLimit.namespace),
        configuredProvider,
        resolveNitroHosting(configuredNitro) === "cloudflare",
        cliDiscovery ? undefined : devHandler,
        projectRoot,
      )
      ;(config as { nitro?: unknown }).nitro = nitro
    },
    async configResolved(config) {
      const cliDiscovery = "vitehubCliDiscovery" in config && config.vitehubCliDiscovery === true
      resolved = config
      rateLimit = config.rateLimit ?? rateLimit
      composedOutput = useProviderOutputCatalog(config)
      projectRoot = resolveViteHubProjectRoot(config.root, { projectRoot: rateLimit.projectRoot })
      const configuredNitro = (config as { nitro?: unknown }).nitro
      const nitroCloudflare = resolveNitroHosting(configuredNitro) === "cloudflare"
      cloudflareOwnedByNitro = hasNitroConfigContext(config) && nitroCloudflare
      provider = resolveProvider(rateLimit, config.command, configuredNitro)!
      collectDeclarations()
      if (config.command === "serve" && !cliDiscovery) devHandler ??= resolve(projectRoot, generatedNitroDevHandler)
      ;(config as { nitro?: unknown }).nitro = mergeNitroConfig(
        config,
        configuredNitro,
        declarations,
        resolveRateLimitNamespace(rateLimit.namespace),
        provider,
        nitroCloudflare,
        config.command === "serve" && !cliDiscovery ? devHandler : undefined,
        projectRoot,
      )
      await writeRateLimitManifest(projectRoot, declarations, provider)
      const pluginFile = resolve(projectRoot, generatedNitroPlugin)
      const runtimeFile = resolve(projectRoot, generatedRuntimeModule)
      const runtimeConfig = { provider } satisfies RateLimitRuntimeConfig
      await Promise.all([
        writeFileIfChanged(pluginFile, renderRuntimeInstaller(runtimeConfig, importBase, true)),
        writeFileIfChanged(runtimeFile, renderRuntimeInstaller(runtimeConfig, importBase, false)),
        ...(config.command === "serve" && !cliDiscovery && devHandler
          ? [writeFileIfChanged(devHandler, renderViteHubNitroDevHandler({ arguments: [runtimeToken], export: "handleRateLimitDevRequest", module: `${importBase}/runtime/console` }))]
          : []),
      ])
      contributeProviderRuntime(composedOutput, { owner: "rate-limit", runtimeModules: { cloudflare: runtimeFile } })
    },
    configureServer(server) {
      registerRateLimitDevEndpoint(server, {
        runtimeToken,
        nitroBaseURL: () => {
          // SAFETY: Vite keeps unknown user config keys on the resolved config. Nitro reads the same `nitro` key.
          const baseURL = (resolved as (ResolvedConfig & { nitro?: { baseURL?: unknown } }) | undefined)?.nitro?.baseURL
          return v.is(v.string(), baseURL) ? baseURL : process.env.NITRO_APP_BASE_URL
        },
      })
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
      const rootDir = projectRoot
      if (!rootDir) return
      return `import ${JSON.stringify(normalizePath(resolve(rootDir, generatedRuntimeModule)))}\n${code}`
    },
    buildStart() {
      providerOutputGenerations.capture(this, composedOutput)
    },
    async buildEnd(error) {
      if (error) {
        await providerOutputGenerations.reset(this, composedOutput, error)
        return
      }
      if (!resolved || shouldSkipViteProviderBuild(resolved.command, getViteMode())) return
      try {
        if (cloudflareOwnedByNitro && provider === "cloudflare") {
          const configuredDeclarations = declarations
          collectDeclarations()
          if (JSON.stringify(declarations) !== JSON.stringify(configuredDeclarations)) {
            throw rateLimitErrorDiagnostics.RATE_LIMIT_B0004({ message: "[vitehub] Nitro Cloudflare Rate Limit declarations changed after config resolution. Generate Rate Limit source files before Vite config resolves." })
          }
        }
        else {
          collectDeclarations()
        }
        const namespace = resolveRateLimitNamespace(rateLimit.namespace)
        const config = resolved
        const rootDir = projectRoot
        if (!rootDir) return
        const contributionDeclarations = declarations
        const contributionPreviousDeclarations = previousDeclarations
        contributeProviderDeploymentOutput(composedOutput, {
          owner: "rate-limit",
          rootDir,
          write: async ({ signal, write }) => {
            await writeRateLimitProviderOutput({
              clientOutDir: config.build.outDir,
              cloudflareOwnedByNitro,
              declarations: contributionDeclarations,
              namespace,
              previousDeclarations: contributionPreviousDeclarations,
              provider,
              rootDir,
              signal,
            }, write)
            signal.throwIfAborted()
            previousDeclarations = contributionDeclarations
          },
        }, providerOutputGenerations.get(this))
      }
      catch (error) {
        await providerOutputGenerations.reset(this, composedOutput, error)
        throw error
      }
    },
    async renderError(error) {
      await providerOutputGenerations.reset(this, composedOutput, error)
    },
    closeBundle: {
      order: "post",
      sequential: true,
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
