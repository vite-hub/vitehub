import { reportViteHubHint, startViteHubHints } from "@vite-hub/internal/hints"
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
import { resolveKVRateLimitDriver } from "./internal/kv-provider.ts"
import { assertCloudflareRateLimitPolicies, createCloudflareRateLimitBindings, usesCloudflareBinding } from "./internal/cloudflare-bindings.ts"

import type { DurabilityPluginMetadata } from "@vite-hub/internal/durability"
import type { ViteHubCliPluginMetadata } from "@vite-hub/internal/cli"
import type { ViteHubInspectionPluginMetadata } from "@vite-hub/internal/inspect"
import type { OperationContributionEntry } from "@vite-hub/internal/operations"
import type { Plugin, ResolvedConfig, UserConfig } from "vite"
import type { RateLimitDeclaration, RateLimitOptions, RateLimitRuntimeConfig } from "./types.ts"
import { rateLimitErrorDiagnostics } from "./error-diagnostics.ts"
import { normalizeRateLimitPolicy } from "./policy.ts"

const operationsModule = ownModule(import.meta.url, "operations")
const runtimeModule = ownModule(import.meta.url, "runtime")

export { discoverRateLimitDeclarations } from "./discovery.ts"
export { inspectRateLimitDefinitions, type RateLimitInspectionOptions, rateLimitConsoleSection } from "./inspect.ts"

const packageName = "@vite-hub/rate-limit"
const pluginName = "@vite-hub/rate-limit/vite"
const generatedNitroPlugin = ".vitehub/nitro/rate-limit/plugin.ts"
const mergeNoExternal = createNoExternalAddition(packageName)

interface InternalRateLimitOptions extends RateLimitOptions {
  kvImport?: string
  memoryFallback?: boolean
}

type ResolvedRateLimitDriver = RateLimitRuntimeConfig["driver"]

export type RateLimitVitePluginOptions = RateLimitOptions
export type RateLimitVitePlugin = Plugin & { vitehub: ViteHubCliPluginMetadata & ViteHubInspectionPluginMetadata & DurabilityPluginMetadata & { operations: readonly OperationContributionEntry[] } }
type RateLimitConfig = UserConfig | ResolvedConfig

type KVConfigReader = () => { kv: false | { store: { driver: string } } }
interface KVVitePlugin {
  api?: { getBuildConfig?: KVConfigReader, getConfig?: KVConfigReader }
}

function kvStoreDriver(config: ResolvedConfig, build = false): string | undefined {
  // SAFETY: The plugin name identifies KV, which owns driver selection and this configuration API.
  const kvPlugin = config.plugins?.find(plugin => plugin.name === "@vite-hub/kv/vite") as KVVitePlugin | undefined
  const api = kvPlugin?.api
  const kv = (build ? api?.getBuildConfig?.() : undefined)?.kv ?? api?.getConfig?.().kv
  return kv ? kv.store.driver : undefined
}

function effectiveDriver(driver: ResolvedRateLimitDriver, config: ResolvedConfig): ResolvedRateLimitDriver {
  return driver === "kv" ? resolveKVRateLimitDriver(kvStoreDriver(config)) : driver
}

function mergeNitroConfig(
  config: RateLimitConfig,
  value: unknown,
  declarations: RateLimitDeclaration[],
  namespace: string | undefined,
  driver: ResolvedRateLimitDriver | undefined,
  nitroCloudflare: boolean,
  projectRoot: string,
): Record<string, unknown> {
  const providerOutput = useProviderOutputCatalog(config)
  const nitro = cloneNitroConfig(value)
  const kit = createNitroServerKit(nitro)
  kit.addPlugin(resolve(projectRoot, generatedNitroPlugin), "start")
  const baseNitro = kit.config
  if (!nitroCloudflare || driver !== "cloudflare" || declarations.length === 0) {
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

function renderRuntimeInstaller(runtimeConfig: RateLimitRuntimeConfig, kvImport: string, kvWindows: boolean): string {
  if (runtimeConfig.driver === "cloudflare" && kvWindows) {
    return [
      "import { definePlugin } from 'nitro'",
      `import { setRateLimitRuntimeConfig } from ${JSON.stringify(runtimeModule)}`,
      `import { getKVStoreDriver, kv } from ${JSON.stringify(kvImport)}`,
      "",
      `const config = ${JSON.stringify(runtimeConfig)}`,
      "export default definePlugin(() => {",
      "  setRateLimitRuntimeConfig(config, { driver: () => getKVStoreDriver(), storage: kv, store: 'default' })",
      "})",
      "",
    ].join("\n")
  }
  if (runtimeConfig.driver !== "kv") {
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
  return [
    "import { definePlugin } from 'nitro'",
    `import { resolveRateLimitDriver, setRateLimitRuntimeConfig } from ${JSON.stringify(runtimeModule)}`,
    `import { getKVStoreDriver, kv } from ${JSON.stringify(kvImport)}`,
    "",
    `const config = ${JSON.stringify(runtimeConfig)}`,
    "export default definePlugin(() => {",
    "  setRateLimitRuntimeConfig(config, { driver: () => getKVStoreDriver(), storage: kv, store: 'default' })",
    "  void resolveRateLimitDriver().catch(error => console.error('[vitehub] Rate Limit could not read the KV store. Each request tries again.', error))",
    "})",
    "",
  ].join("\n")
}

function resolveRateLimitNamespace(configured?: string): string | undefined {
  return configured?.trim() || undefined
}

function resolveDriver(options: RateLimitOptions, command: "build" | "serve", nitro: unknown, deferUnknown = false): ResolvedRateLimitDriver | undefined {
  if (options.driver === undefined && Object.hasOwn(options, "provider")) {
    // SAFETY: An app config without types still passes the former `provider` key.
    const provider = (options as { provider?: unknown }).provider
    throw rateLimitErrorDiagnostics.RATE_LIMIT_RENAMED_PROVIDER_KEY({ value: JSON.stringify(provider) ?? String(provider) })
  }
  if (options.driver && options.driver !== "auto") return options.driver
  if (command === "serve") return "memory"
  const hosting = getHostingProvider(resolveHost({ nitro }))
  if (hosting === "cloudflare") return "cloudflare"
  if (hosting) {
    throw rateLimitErrorDiagnostics.RATE_LIMIT_B0002({ message: `[vitehub] Rate Limit has no native ${hosting} driver. Configure a custom Rate Limiter instead of falling back to per-instance memory.` })
  }
  if (deferUnknown) return
  throw rateLimitErrorDiagnostics.RATE_LIMIT_B0003({ message: "[vitehub] Rate Limit driver cannot be inferred for a production build. Set rateLimit.driver to \"cloudflare\" or explicitly choose \"memory\" for a known single-process deployment." })
}

function buildTargetsCloudflare(config: ResolvedConfig, configured: RateLimitOptions, nitro: unknown): boolean {
  if (getDeploymentHost(config) === "cloudflare") return true
  if (configured.driver === "cloudflare") return true
  return (configured.driver ?? "auto") === "auto" && getHostingProvider(resolveHost({ nitro })) === "cloudflare"
}

export function hubRateLimit(options: RateLimitVitePluginOptions = {}): RateLimitVitePlugin {
  const kvImport = (options as InternalRateLimitOptions).kvImport ?? "@vite-hub/kv"
  let rateLimit: RateLimitOptions = options
  let declarations: RateLimitDeclaration[] = []
  let cloudflareBindings = false
  let checkCloudflarePolicies = false
  let driver: ResolvedRateLimitDriver = "memory"
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
    if (checkCloudflarePolicies) assertCloudflareRateLimitPolicies(declarations, kvStoreDriver(resolved, true))
    await writeRateLimitManifest(projectRoot, declarations, effectiveDriver(driver, resolved))
  }

  const assertBuildDriver = (): void => {
    if (!resolved || resolved.command !== "build") return
    const effective = effectiveDriver(driver, resolved)
    if (effective === "cloudflare") {
      assertCloudflareRateLimitPolicies(declarations, kvStoreDriver(resolved))
      return
    }
    if (effective !== "memory") return
    if (driver === "kv" && !(rateLimit as InternalRateLimitOptions).memoryFallback) {
      const kv = kvStoreDriver(resolved)
      const store = kv ? `the default KV store uses ${kv}, which has no shared atomic increment` : "the app has no KV store"
      throw rateLimitErrorDiagnostics.RATE_LIMIT_KV_STORE_UNSUPPORTED({ message: `[vitehub] rateLimit.driver is "kv", but ${store}. Each server process would count in its own memory.` })
    }
    const strict = declarations.find(declaration => normalizeRateLimitPolicy(declaration.policy).enforcement === "strict")
    if (strict) {
      throw rateLimitErrorDiagnostics.RATE_LIMIT_MEMORY_STRICT_UNSUPPORTED({ message: `[vitehub] Rate Limit "${strict.name}" requires strict enforcement, but this build counts in the memory of each server process, so several instances each allow the full limit.` })
    }
  }

  const warnAboutMemory = (): void => {
    if (!resolved || warnedAboutMemory || resolved.command !== "build" || declarations.length === 0 || effectiveDriver(driver, resolved) !== "memory") return
    reportViteHubHint(resolved, rateLimitErrorDiagnostics.RATE_LIMIT_MEMORY_PER_PROCESS())
    warnedAboutMemory = true
  }

  const inspectionRoot = (): string => projectRoot ?? resolveViteHubProjectRoot(process.cwd(), { projectRoot: rateLimit.projectRoot })

  async function writeRuntimeOutput(config: ResolvedConfig, root: string): Promise<void> {
    const runtimeConfig: RateLimitRuntimeConfig = { driver }
    if (driver === "kv" && ((rateLimit as InternalRateLimitOptions).memoryFallback === true || config.command === "serve")) {
      runtimeConfig.memoryFallback = true
    }
    const kvWindows = driver === "cloudflare" && !declarations.every(usesCloudflareBinding)
    const namespace = resolveRateLimitNamespace(rateLimit.namespace)
    if (kvWindows && namespace) runtimeConfig.namespace = namespace
    await writeRateLimitManifest(root, declarations, effectiveDriver(driver, config))
    await writeFileIfChanged(resolve(root, generatedNitroPlugin), renderRuntimeInstaller(runtimeConfig, kvImport, kvWindows))
  }

  return {
    api: {
      async validateNitroBuild(config: ResolvedConfig) {
        resolved = config
        rateLimit = getResolvedFeatureOptions<RateLimitOptions>(config, "rateLimit") ?? rateLimit
        projectRoot = resolveViteHubProjectRoot(config.root, { projectRoot: rateLimit.projectRoot })
        driver = resolveDriver(rateLimit, config.command, (config as { nitro?: unknown }).nitro)!
        collectDeclarations()
        assertBuildDriver()
        await writeRuntimeOutput(config, projectRoot)
      },
    },
    name: pluginName,
    enforce: "pre",
    vitehub: {
      durability: () => [{ export: "rateLimitDurability", input: { driver }, module: durabilityModuleFile(import.meta.url), primitive: "rate-limit" }],
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
        const configuredDriver = resolveDriver(rateLimit, env?.command ?? "serve", configuredNitro, true)
        if (configuredDriver) driver = configuredDriver
        collectDeclarations()
        const nitro = mergeNitroConfig(
          config,
          configuredNitro,
          declarations,
          resolveRateLimitNamespace(rateLimit.namespace),
          configuredDriver,
          resolveHost({ nitro: configuredNitro }) === "cloudflare",
          projectRoot,
        )
        ;(config as { nitro?: unknown }).nitro = nitro
        return installStandaloneOperationRpc(config, env?.command ?? "build", operationsModule)
      },
    },
    async configResolved(config) {
      startViteHubHints(config)
      resolved = config
      warnedAboutMemory = false
      rateLimit = getResolvedFeatureOptions<RateLimitOptions>(config, "rateLimit") ?? rateLimit
      projectRoot = resolveViteHubProjectRoot(config.root, { projectRoot: rateLimit.projectRoot })
      const configuredNitro = (config as { nitro?: unknown }).nitro
      const nitroCloudflare = resolveHost({ nitro: configuredNitro }) === "cloudflare"
      driver = resolveDriver(rateLimit, config.command, configuredNitro)!
      cloudflareBindings = nitroCloudflare && driver === "cloudflare"
      checkCloudflarePolicies = config.command === "serve" && buildTargetsCloudflare(config, rateLimit, configuredNitro)
      collectDeclarations()
      if (checkCloudflarePolicies) assertCloudflareRateLimitPolicies(declarations, kvStoreDriver(config, true))
      ;(config as { nitro?: unknown }).nitro = mergeNitroConfig(
        config,
        configuredNitro,
        declarations,
        resolveRateLimitNamespace(rateLimit.namespace),
        driver,
        nitroCloudflare,
        projectRoot,
      )
      await writeRuntimeOutput(config, projectRoot)
      if (driver !== "kv") {
        assertBuildDriver()
        warnAboutMemory()
      }
    },
    async buildStart() {
      if (driver !== "kv") return
      await refreshDeclarations()
      assertBuildDriver()
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
