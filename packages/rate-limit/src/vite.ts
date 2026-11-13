import { installStandaloneOperationRpc, publishStandaloneOperationServer } from "@vite-hub/internal/operations-vite"
import { durabilityModuleFile } from "@vite-hub/internal/durability"
import { ownModule } from "@vite-hub/internal/build/paths"
import { resolve } from "node:path"

import {
  composeNitroCloudflareProviderOutput,
  contributeCloudflareProviderOutput,
  shouldSkipViteProviderBuild,
  useProviderOutputCatalog,
} from "@vite-hub/internal/build/deployment-output"
import { createNoExternalAddition, getDeploymentHost, getResolvedFeatureOptions, isServerEnvironment, resolveViteHubProjectRoot } from "@vite-hub/internal/build/vite"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"
import { writeFileIfChanged } from "@vite-hub/internal/definition-catalog"
import { getHostingProvider, resolveHost } from "@vite-hub/internal/hosting"
import { cloneRecord as cloneNitroConfig } from "@vite-hub/internal/object"

import { createRateLimitCatalogDiscovery } from "./discovery.ts"
import { inspectRateLimitDefinitions } from "./inspect.ts"
import { writeRateLimitManifest } from "./internal/manifest.ts"
import { resolveKVRateLimitProvider } from "./internal/kv-provider.ts"
import { assertCloudflareRateLimitPolicies, createCloudflareRateLimitBindings } from "./internal/cloudflare-bindings.ts"

import type { DurabilityPluginMetadata } from "@vite-hub/internal/durability"
import type { ViteHubCliPluginMetadata } from "@vite-hub/internal/cli"
import type { ViteHubInspectionPluginMetadata } from "@vite-hub/internal/inspect"
import type { OperationContributionEntry } from "@vite-hub/internal/operations"
import type { Plugin, ResolvedConfig, UserConfig } from "vite"
import type { RateLimitDeclaration, RateLimitOptions, RateLimitRuntimeConfig } from "./types.ts"
import { rateLimitErrorDiagnostics } from "./error-diagnostics.ts"

// Generated code imports these modules by path, so they need no package export.
const operationsModule = ownModule(import.meta.url, "operations")
const runtimeModule = ownModule(import.meta.url, "runtime")

export { discoverRateLimitDeclarations } from "./discovery.ts"
export { inspectRateLimitDefinitions, type RateLimitInspectionOptions, rateLimitConsoleSection } from "./inspect.ts"

const packageName = "@vite-hub/rate-limit"
const pluginName = "@vite-hub/rate-limit/vite"
const generatedNitroPlugin = ".vitehub/nitro/rate-limit/plugin.ts"
const mergeNoExternal = createNoExternalAddition(packageName)

interface InternalRateLimitOptions extends RateLimitOptions {
  /** The module that exports `kv` and `getKVStoreDriver` for the `kv` provider. */
  kvImport?: string
}

type ResolvedRateLimitProvider = RateLimitRuntimeConfig["provider"]

export type RateLimitVitePluginOptions = RateLimitOptions
export type RateLimitVitePlugin = Plugin & { vitehub: ViteHubCliPluginMetadata & ViteHubInspectionPluginMetadata & DurabilityPluginMetadata & { operations: readonly OperationContributionEntry[] } }
type RateLimitConfig = UserConfig | ResolvedConfig

/** The part of the KV integration that describes its build-selected default store. */
interface KVVitePlugin {
  api?: { getConfig?: () => { kv: false | { store: { driver: string } } } }
}

function effectiveProvider(provider: ResolvedRateLimitProvider, config: ResolvedConfig): ResolvedRateLimitProvider {
  if (provider !== "kv") return provider
  // SAFETY: The plugin name identifies KV, which owns driver selection and this configuration API.
  const kvPlugin = config.plugins?.find(plugin => plugin.name === "@vite-hub/kv/vite") as KVVitePlugin | undefined
  const kv = kvPlugin?.api?.getConfig?.().kv
  return resolveKVRateLimitProvider(kv ? kv.store.driver : undefined)
}

function mergeNitroConfig(
  config: RateLimitConfig,
  value: unknown,
  declarations: RateLimitDeclaration[],
  namespace: string | undefined,
  provider: ResolvedRateLimitProvider | undefined,
  nitroCloudflare: boolean,
  projectRoot: string,
): Record<string, unknown> {
  const providerOutput = useProviderOutputCatalog(config)
  const nitro = cloneNitroConfig(value)
  const kit = createNitroServerKit(nitro)
  kit.addPlugin(resolve(projectRoot, generatedNitroPlugin), "start")
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

function renderRuntimeInstaller(runtimeConfig: RateLimitRuntimeConfig, kvImport: string): string {
  if (runtimeConfig.provider !== "kv") {
    return [
      "import { definePlugin } from 'nitro'",
      `import { setRateLimitRuntimeConfig } from ${JSON.stringify(runtimeModule)}`,
      "",
      `const config = ${JSON.stringify(runtimeConfig)}`,
      "export default definePlugin(() => {",
      "  setRateLimitRuntimeConfig(config)",
      "})",
      "",
    ].join("\n")
  }
  // The plugin asks KV for its configured driver at boot and prints the Rate Limit provider.
  return [
    "import { definePlugin } from 'nitro'",
    `import { resolveRateLimitProvider, setRateLimitRuntimeConfig } from ${JSON.stringify(runtimeModule)}`,
    `import { getKVStoreDriver, kv } from ${JSON.stringify(kvImport)}`,
    "",
    `const config = ${JSON.stringify(runtimeConfig)}`,
    "export default definePlugin(() => {",
    "  setRateLimitRuntimeConfig(config, { driver: () => getKVStoreDriver(), storage: kv, store: 'default' })",
    "  void resolveRateLimitProvider().catch(error => console.error('[vitehub] Rate Limit could not read the KV store. Each request tries again.', error))",
    "})",
    "",
  ].join("\n")
}

/** A build that counts in memory gets one warning, so a multi-instance deploy does not hide it. */
const memoryBuildWarning = "[vitehub] Rate Limit counts requests in the memory of each server process. With several instances, each one allows the full limit. To share the counts, enable KV on Node (ViteHub then selects the kv provider), or set rateLimit.provider to \"kv\", and configure a Redis KV store or use a Postgres Database."

function resolveRateLimitNamespace(configured?: string): string | undefined {
  return configured?.trim() || undefined
}

function resolveProvider(options: RateLimitOptions, command: "build" | "serve", nitro: unknown, deferUnknown = false): ResolvedRateLimitProvider | undefined {
  if (options.provider && options.provider !== "auto") return options.provider
  if (command === "serve") return "memory"
  const hosting = getHostingProvider(resolveHost({ nitro }))
  if (hosting === "cloudflare") return "cloudflare"
  if (hosting) {
    throw rateLimitErrorDiagnostics.RATE_LIMIT_B0002({ message: `[vitehub] Rate Limit has no native ${hosting} driver. Configure a custom Rate Limiter instead of falling back to per-instance memory.` })
  }
  if (deferUnknown) return
  throw rateLimitErrorDiagnostics.RATE_LIMIT_B0003({ message: "[vitehub] Rate Limit provider cannot be inferred for a production build. Set rateLimit.provider to \"cloudflare\" or explicitly choose \"memory\" for a known single-process deployment." })
}

function buildTargetsCloudflare(config: ResolvedConfig, configured: RateLimitOptions, nitro: unknown): boolean {
  // ViteHub records the host separately from its memory runtime provider in dev.
  if (getDeploymentHost(config) === "cloudflare") return true
  if (configured.provider === "cloudflare") return true
  return (configured.provider ?? "auto") === "auto" && getHostingProvider(resolveHost({ nitro })) === "cloudflare"
}

export function hubRateLimit(options: RateLimitVitePluginOptions = {}): RateLimitVitePlugin {
  const kvImport = (options as InternalRateLimitOptions).kvImport ?? "@vite-hub/kv"
  let rateLimit: RateLimitOptions = options
  let declarations: RateLimitDeclaration[] = []
  let cloudflareBindings = false
  // The dev server runs the memory driver, so it checks the policies that the Cloudflare build rejects.
  let checkCloudflarePolicies = false
  let provider: ResolvedRateLimitProvider = "memory"
  let projectRoot: string | undefined
  let resolved: ResolvedConfig | undefined
  let warnedAboutMemory = false

  const discoverRateLimitCatalog = createRateLimitCatalogDiscovery()

  const collectDeclarations = (): void => {
    if (!projectRoot) return
    const catalog = discoverRateLimitCatalog({
      rootDir: projectRoot,
      scanDirs: rateLimit.scanDirs,
    })
    declarations = catalog.declarations
  }

  const refreshDeclarations = async (): Promise<void> => {
    if (!projectRoot || !resolved) return
    collectDeclarations()
    if (checkCloudflarePolicies) assertCloudflareRateLimitPolicies(declarations)
    await writeRateLimitManifest(projectRoot, declarations, effectiveProvider(provider, resolved))
  }

  const warnAboutMemory = (): void => {
    if (!resolved || warnedAboutMemory || resolved.command !== "build" || declarations.length === 0 || effectiveProvider(provider, resolved) !== "memory") return
    resolved.logger.warn(memoryBuildWarning)
    warnedAboutMemory = true
  }

  const inspectionRoot = (): string => projectRoot ?? resolveViteHubProjectRoot(process.cwd(), { projectRoot: rateLimit.projectRoot })

  return {
    name: pluginName,
    // Apply before Nitro's config hook so Nitro captures the composed output
    // regardless of plugin registration order.
    enforce: "pre",
    vitehub: {
      durability: () => [{ export: "rateLimitDurability", input: { provider }, module: durabilityModuleFile(import.meta.url), primitive: "rate-limit" }],
      // The Console, `vitehub rate-limit`, and agents run these.
      operations: [{ export: "rateLimitOperations", load: async () => (await import(/* @vite-ignore */ import.meta.url.endsWith(".ts") ? "./operations.ts" : "./operations.js")).rateLimitOperations, module: operationsModule }],
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
    config: {
      order: "pre",
      handler(config, env) {
        rateLimit = getResolvedFeatureOptions<RateLimitOptions>(config, "rateLimit") ?? rateLimit
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
          resolveHost({ nitro: configuredNitro }) === "cloudflare",
          projectRoot,
        )
        ;(config as { nitro?: unknown }).nitro = nitro
        return installStandaloneOperationRpc(config, env?.command ?? "build", operationsModule)
      },
    },
    async configResolved(config) {
      resolved = config
      warnedAboutMemory = false
      rateLimit = getResolvedFeatureOptions<RateLimitOptions>(config, "rateLimit") ?? rateLimit
      projectRoot = resolveViteHubProjectRoot(config.root, { projectRoot: rateLimit.projectRoot })
      const configuredNitro = (config as { nitro?: unknown }).nitro
      const nitroCloudflare = resolveHost({ nitro: configuredNitro }) === "cloudflare"
      provider = resolveProvider(rateLimit, config.command, configuredNitro)!
      cloudflareBindings = nitroCloudflare && provider === "cloudflare"
      checkCloudflarePolicies = config.command === "serve" && buildTargetsCloudflare(config, rateLimit, configuredNitro)
      collectDeclarations()
      if (checkCloudflarePolicies) assertCloudflareRateLimitPolicies(declarations)
      ;(config as { nitro?: unknown }).nitro = mergeNitroConfig(
        config,
        configuredNitro,
        declarations,
        resolveRateLimitNamespace(rateLimit.namespace),
        provider,
        nitroCloudflare,
        projectRoot,
      )
      await writeRateLimitManifest(projectRoot, declarations, effectiveProvider(provider, config))
      const pluginFile = resolve(projectRoot, generatedNitroPlugin)
      const runtimeConfig = { provider } satisfies RateLimitRuntimeConfig
      await writeFileIfChanged(pluginFile, renderRuntimeInstaller(runtimeConfig, kvImport))
      // KV rereads Database's resolved definitions at buildStart; avoid warning before that choice is final.
      if (provider !== "kv") warnAboutMemory()
    },
    async buildStart() {
      if (provider !== "kv") return
      await refreshDeclarations()
      warnAboutMemory()
    },
    configureServer(server) {
      publishStandaloneOperationServer(server)
    },
    configEnvironment(name, config) {
      if (!isServerEnvironment(name, config)) return
      return { resolve: { noExternal: mergeNoExternal(config.resolve?.noExternal) } }
    },
    async handleHotUpdate(context) {
      if (!/\.(?:c|m)?[jt]sx?$/i.test(context.file)) return
      resolved = context.server.config
      try {
        await refreshDeclarations()
      }
      catch (error) {
        // Vite drops errors from this hook, so log them.
        context.server.config.logger.error(String(error), { error: error instanceof Error ? error : undefined })
      }
    },
    buildEnd(error) {
      if (error || !cloudflareBindings || !resolved || shouldSkipViteProviderBuild(resolved.command)) return
      const configuredDeclarations = declarations
      collectDeclarations()
      if (JSON.stringify(declarations) !== JSON.stringify(configuredDeclarations)) {
        throw rateLimitErrorDiagnostics.RATE_LIMIT_B0004({ message: "[vitehub] Nitro Cloudflare Rate Limit declarations changed after config resolution. Generate Rate Limit source files before Vite config resolves." })
      }
    },
  }
}
