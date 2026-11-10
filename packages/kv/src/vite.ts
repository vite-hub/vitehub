import { ownModule } from "@vite-hub/internal/build/paths"
import { resolve } from "node:path"

import { installStandaloneOperationRpc, publishStandaloneOperationServer } from "@vite-hub/internal/operations-vite"

import {
  KV_VIRTUAL_CONFIG_ID,
  KV_VITE_PLUGIN_NAME,
  resolveKVViteConfig,
} from "./vite-config.ts"

import {
  contributeProviderDeploymentOutput,
  createProviderDeploymentOutputGenerationState,
  finalizeProviderDeploymentOutputs,
  isProviderJsonRecord,
  useProviderOutputCatalog,
} from "@vite-hub/internal/build/deployment-output"
import { getViteMode } from "@vite-hub/internal/build/mode"
import { createNoExternalAddition, hasNitroConfigContext, isServerEnvironment, resolveViteHubProjectRoot, shouldSkipViteProviderBuild } from "@vite-hub/internal/build/vite"
import { isPlainObject } from "@vite-hub/internal/object"
import { relativeDefinitionFile } from "@vite-hub/internal/inspect"
import { readProvisionStateSync } from "@vite-hub/internal/provision-state"

import { configureCloudflareKV } from "./integrations/cloudflare.ts"
import { inspectKVResources, inspectKVStores } from "./inspect.ts"
import { createKVCloudflareProvisionStep } from "./provision.ts"
import { resolveUpstashRuntimeValues } from "./runtime/upstash.ts"

import type { KVResolutionInput } from "./config.ts"
import type { KVViteRuntimeConfig } from "./vite-config.ts"
import type { KVOptions, ResolvedKVModuleOptions, ResolvedKVStoreConfig } from "./types.ts"
import type { ProviderJsonRecord } from "@vite-hub/internal/build/deployment-output"
import type { ViteHubCliContributor, ViteHubCliPluginMetadata } from "@vite-hub/internal/cli"
import type { ViteHubInspectionPluginMetadata } from "@vite-hub/internal/inspect"
import type { OperationContributionEntry } from "@vite-hub/internal/operations"
import type { Plugin, ResolvedConfig } from "vite"

// Generated code imports these modules by path, so they need no package export.
const operationsModule = ownModule(import.meta.url, "operations")

const RESOLVED_KV_VIRTUAL_CONFIG_ID = `\0${KV_VIRTUAL_CONFIG_ID}`
const KV_RUNTIME_ID = "#vitehub/kv/runtime"
const RESOLVED_KV_RUNTIME_ID = `\0${KV_RUNTIME_ID}`
const KV_ERRORS_IMPORT_ID = ownModule(import.meta.url, "errors")
const UPSTASH_DRIVER_IMPORT_ID = "@vite-hub/kv/runtime/upstash-driver"
const CLOUDFLARE_KV_RUNTIME_IMPORT_ID = ownModule(import.meta.url, "runtime/cloudflare-kv")
// Nitro registers middleware by file path.
const KV_CLOUDFLARE_REQUEST_ENV_MIDDLEWARE = ownModule(import.meta.url, "runtime/cloudflare-request-env")
/** The unstorage driver that Nitro's `cache` mount uses to store its entries in the app's default KV store. */
export const kvNitroCacheDriver: string = ownModule(import.meta.url, "runtime/nitro-cache")
const mergeNoExternal = createNoExternalAddition("@vite-hub/kv")
const KV_CLOUDFLARE_BINDINGS_FILE = ".vitehub-kv-bindings.json"

export { KV_VIRTUAL_CONFIG_ID, KV_VITE_PLUGIN_NAME, resolveKVViteConfig }
export type { KVViteRuntimeConfig } from "./vite-config.ts"

export interface KVVitePluginAPI {
  getConfig: () => KVViteRuntimeConfig
}

export type KVVitePlugin = Plugin & {
  api: KVVitePluginAPI
  nitro: {
    name: string
    setup: (nitro: { options: NitroCloudflareKVTarget }) => void
  }
  vitehub: ViteHubCliPluginMetadata & ViteHubInspectionPluginMetadata & { operations: readonly OperationContributionEntry[] }
}

export function hubKvOptionalPeerResolver(): Plugin {
  return {
    name: "@vite-hub/kv/optional-peers",
    enforce: "pre",
    resolveId(id, importer, resolveOptions) {
      if (!resolveOptions?.ssr) return
      if (isKVOptionalUpstashImport(id, importer) || isUnstorageCloudflareWorkersImport(id, importer)) return { external: true, id }
    },
  }
}

function serializeVirtualConfig(config: KVViteRuntimeConfig, env?: Record<string, string | undefined>): string {
  const resolveStore = (store: ResolvedKVStoreConfig) => env && store.driver === "upstash" ? resolveUpstashRuntimeValues(store, env) : store
  // Only the development server module gets .env credentials. The public plugin config and build output stay masked.
  const kv = config.kv && env ? {
    ...config.kv,
    store: resolveStore(config.kv.store),
    ...(config.kv.stores ? { stores: Object.fromEntries(Object.entries(config.kv.stores).map(([name, store]) => [name, resolveStore(store)])) } : {}),
  } : config.kv
  return [
    `export const hosting = ${JSON.stringify(config.hosting)};`,
    `export const kv = ${JSON.stringify(kv)};`,
    "export default { hosting, kv };",
  ].join("\n")
}

function isCloudflareKVConfig(kv: KVViteRuntimeConfig["kv"]): kv is ResolvedKVModuleOptions {
  if (!kv) return false
  return Object.values(kv.stores || { default: kv.store })
    .every(store => store.driver === "cloudflare-kv-binding")
}

function hasCloudflareKVStore(kv: KVViteRuntimeConfig["kv"]): boolean {
  if (!kv) return false
  return Object.values(kv.stores || { default: kv.store }).some(store => store.driver === "cloudflare-kv-binding")
}

/** Registers the middleware that installs the request's Cloudflare env, or removes it when no store uses a binding. */
function configureNitroCloudflareRequestEnv(nitro: NitroCloudflareKVTarget, kv: KVViteRuntimeConfig["kv"]): void {
  const handlers: unknown[] = Array.isArray(nitro.handlers)
    ? nitro.handlers.filter(handler => !(isPlainObject(handler) && handler.handler === KV_CLOUDFLARE_REQUEST_ENV_MIDDLEWARE))
    : []
  // First, so that other middleware can use KV.
  if (hasCloudflareKVStore(kv)) handlers.unshift({ handler: KV_CLOUDFLARE_REQUEST_ENV_MIDDLEWARE, middleware: true })
  if (handlers.length || Array.isArray(nitro.handlers)) nitro.handlers = handlers
}

function hasUpstashStore(kv: KVViteRuntimeConfig["kv"]): boolean {
  if (!kv) return false
  return Object.values(kv.stores || { default: kv.store }).some(store => store.driver === "upstash")
}

function isKVOptionalUpstashImport(id: string, importer: string | undefined): boolean {
  if (id !== UPSTASH_DRIVER_IMPORT_ID || !importer) return false
  const normalizedImporter = importer.replace(/\\/g, "/").split("?", 1)[0]!
  return normalizedImporter.endsWith("/packages/kv/src/runtime/driver.ts")
    || normalizedImporter.endsWith("/packages/kv/dist/index.js")
    || normalizedImporter.includes("/@vite-hub/kv/dist/index.js")
}

// unstorage's Cloudflare drivers load the workerd built-in `cloudflare:workers` with a guarded dynamic import.
// No bundler can resolve it: Workers provide it at runtime. Elsewhere the import only runs when a binding is
// missing from ViteHub's active env, and unstorage turns the rejection into its invalid-binding error.
function isUnstorageCloudflareWorkersImport(id: string, importer: string | undefined): boolean {
  if (id !== "cloudflare:workers" || !importer) return false
  return /[/\\]unstorage[/\\]dist[/\\]/.test(importer)
}

function createCloudflareKVWranglerConfig(kv: KVViteRuntimeConfig["kv"], provisionState: ReturnType<typeof readProvisionStateSync>) {
  if (!kv) return
  const target: { cloudflare?: { wrangler?: { kv_namespaces?: Array<{ binding: string, id?: string }> } } } = {}
  configureCloudflareKV(target, kv, provisionState)
  return target.cloudflare?.wrangler?.kv_namespaces?.length ? target.cloudflare.wrangler : undefined
}

function serializeCloudflareRuntime(config: ResolvedKVModuleOptions): string {
  return [
    `import { createCloudflareKVStorage } from ${JSON.stringify(CLOUDFLARE_KV_RUNTIME_IMPORT_ID)};`,
    `import { kvInvalidLimitError, kvKeyLimitCodes, kvResult, kvStoreNotFoundError, kvStoreWithMode, kvUnsupportedOperationError, kvWriteLimitCodes } from ${JSON.stringify(KV_ERRORS_IMPORT_ID)};`,
    "",
    `const kvConfig = ${JSON.stringify(config, null, 2)}`,
    "const storages = new Map();",
    "export async function disposeKVStores() { storages.clear(); }",
    "",
    "function resolveStoreConfig(name) {",
    "  const stores = kvConfig.stores || { default: kvConfig.store };",
    "  if (!Object.prototype.hasOwnProperty.call(stores, name)) throw kvStoreNotFoundError(name);",
    "  const store = stores[name];",
    "  return store;",
    "}",
    "",
    "function resolveStorage(name = \"default\") {",
    "  const store = resolveStoreConfig(name);",
    "  const existing = storages.get(name);",
    "  if (existing) return existing;",
    "  const storage = createCloudflareKVStorage(store);",
    "  storages.set(name, storage);",
    "  return storage;",
    "}",
    "",
    "function unsupported(operation, name) {",
    "  resolveStoreConfig(name);",
    "  return [kvUnsupportedOperationError(operation, name), undefined];",
    "}",
    "",
    "// kvResult throws config errors, for example an unknown store, and returns the other errors.",
    "function createKVStorage(name = \"default\") {",
    "  return {",
    "    async clear(base, options) { return kvResult(\"clear\", name, async () => { await resolveStorage(name).clear(base, options); }); },",
    "    async del(key, options) { return kvResult(\"del\", name, async () => { await resolveStorage(name).removeItem(key, options); }, kvKeyLimitCodes); },",
    "    async get(key, options) { return kvResult(\"get\", name, () => resolveStorage(name).getItem(key, options), kvKeyLimitCodes); },",
    "    async getAndDelete() { return unsupported(\"getAndDelete\", name); },",
    "    async has(key, options) { return kvResult(\"has\", name, () => resolveStorage(name).hasItem(key, options), kvKeyLimitCodes); },",
    "    async increment() { return unsupported(\"increment\", name); },",
    "    async keys(base, options) { return kvResult(\"keys\", name, () => resolveStorage(name).getKeys(base, options)); },",
    "    async list(options) { if (!Number.isInteger(options.limit) || options.limit <= 0) return [kvInvalidLimitError(), undefined]; return kvResult(\"list\", name, () => resolveStorage(name).listKeys(options), [\"KV_INVALID_CURSOR\"]); },",
    "    async set(key, value, options) { return kvResult(\"set\", name, async () => { await resolveStorage(name).setItem(key, value, options); }, kvWriteLimitCodes); },",
    "    async setIfAbsent() { return unsupported(\"setIfAbsent\", name); },",
    "    store(storeName, options) { return kvStoreWithMode(createKVStorage(storeName), options); },",
    "  };",
    "}",
    "",
    "export const kv = createKVStorage();",
    "",
  ].join("\n")
}

interface NitroCloudflareKVTarget {
  handlers?: unknown[]
  cloudflare?: {
    wrangler?: {
      kv_namespaces?: Array<{ binding: string, id?: string }>
    }
  }
}

function getNitroCloudflareKVNamespaces(target: unknown): ProviderJsonRecord[] {
  if (!isPlainObject(target)) return []
  const cloudflare = Reflect.get(target, "cloudflare")
  if (!isPlainObject(cloudflare)) return []
  const wrangler = Reflect.get(cloudflare, "wrangler")
  if (!isPlainObject(wrangler)) return []
  const namespaces: unknown = Reflect.get(wrangler, "kv_namespaces")
  if (!Array.isArray(namespaces)) return []
  return namespaces.flatMap((namespace) => {
    let normalized: unknown
    try {
      normalized = JSON.parse(JSON.stringify(namespace))
    }
    catch {
      return []
    }
    if (!isProviderJsonRecord(normalized)) return []
    const binding: unknown = Reflect.get(normalized, "binding")
    const id: unknown = Reflect.get(normalized, "id")
    const previewId: unknown = Reflect.get(normalized, "preview_id")
    const experimentalRemote: unknown = Reflect.get(normalized, "experimental_remote")
    const remote: unknown = Reflect.get(normalized, "remote")
    if (typeof binding !== "string") return []
    if (id !== undefined && typeof id !== "string") return []
    if (previewId !== undefined && typeof previewId !== "string") return []
    if (experimentalRemote !== undefined && typeof experimentalRemote !== "boolean") return []
    if (remote !== undefined && typeof remote !== "boolean") return []
    return [normalized]
  })
}

function getResolvedNitroConfig(config: ResolvedConfig): unknown {
  return Reflect.get(config, "nitro")
}

function reconcileNitroCloudflareKV(
  target: NitroCloudflareKVTarget,
  kv: KVViteRuntimeConfig["kv"],
  ownedNamespaces: Set<{ binding: string, id?: string }>,
  provisionState: ReturnType<typeof readProvisionStateSync>,
): void {
  configureNitroCloudflareRequestEnv(target, kv)
  const namespaces = target.cloudflare?.wrangler?.kv_namespaces
  if (namespaces?.length && ownedNamespaces.size) {
    for (const owned of ownedNamespaces) {
      const ownedIndex = namespaces.findIndex(namespace => namespace.binding === owned.binding && namespace.id === owned.id)
      if (ownedIndex !== -1) namespaces.splice(ownedIndex, 1)
    }
  }
  if (kv) configureCloudflareKV(target, kv, provisionState)
}

function configureNitroCloudflareKV(
  config: object,
  options: KVOptions | undefined,
  input: KVResolutionInput,
  ownedNamespaces: Set<{ binding: string, id?: string }>,
  provisionState: ReturnType<typeof readProvisionStateSync>,
): boolean {
  const nitro: unknown = Reflect.get(config, "nitro")
  if (!isPlainObject(nitro)) return false

  // SAFETY: Vite's Nitro config is an open plain object; this function owns only the optional Cloudflare Wrangler fields below.
  const target = nitro as NitroCloudflareKVTarget
  const namespaces = target.cloudflare?.wrangler?.kv_namespaces
  if (namespaces && ownedNamespaces.size) {
    target.cloudflare!.wrangler!.kv_namespaces = namespaces.filter(namespace => !ownedNamespaces.has(namespace))
  }
  ownedNamespaces.clear()

  const kv = resolveKVViteConfig(options, input).kv
  configureNitroCloudflareRequestEnv(target, kv)
  if (kv) {
    const existingNamespaces = new Set(target.cloudflare?.wrangler?.kv_namespaces)
    configureCloudflareKV(target, kv, provisionState)
    for (const namespace of target.cloudflare?.wrangler?.kv_namespaces ?? []) {
      if (!existingNamespaces.has(namespace)) ownedNamespaces.add(namespace)
    }
  }
  return true
}

/** `input.hosting` names the host preset for driver inference, as `vitehub()` passes it. Without it, KV reads the host from env. */
export function hubKv(options?: KVOptions, input: Pick<KVResolutionInput, "hosting"> = {}): KVVitePlugin {
  let command: "build" | "serve" = "build"
  let mode = "development"
  let viteEnv: Record<string, string> | undefined
  // `vite dev` keeps a store local unless it sets `remote: true`. Builds ignore `remote`.
  const resolutionInput = (): KVResolutionInput => ({ dev: command === "serve", env: command === "serve" ? viteEnv : undefined, hosting: input.hosting })
  let nitroOwned = false
  let nitroOptions: NitroCloudflareKVTarget | undefined
  const ownedNitroNamespaces = new Set<{ binding: string, id?: string }>()
  let resolved: ResolvedConfig | undefined
  let providerOutput: ReturnType<typeof useProviderOutputCatalog> | undefined
  let runtimeConfig: KVViteRuntimeConfig | undefined
  let projectRoot = process.cwd()
  const getConfig = () => runtimeConfig ??= resolveKVViteConfig(options, resolutionInput())
  const providerOutputGenerations = createProviderDeploymentOutputGenerationState()

  return {
    name: KV_VITE_PLUGIN_NAME,
    enforce: "post",
    api: { getConfig },
    nitro: {
      name: "@vite-hub/kv/cloudflare-bindings",
      setup(nitro) {
        nitroOptions = nitro.options
        if (runtimeConfig) reconcileNitroCloudflareKV(nitroOptions, runtimeConfig.kv, ownedNitroNamespaces, readProvisionStateSync(projectRoot))
      },
    },
    vitehub: {
      inspect: () => {
        const build = resolveKVViteConfig(options, { hosting: input.hosting }).kv
        const dev = resolveKVViteConfig(options, { dev: true, env: viteEnv, hosting: input.hosting }).kv
        if (!build || !dev) return
        const file = resolved?.configFile ? relativeDefinitionFile(projectRoot, resolved.configFile) : "vite.config.ts"
        return {
          definitions: [{ kind: "kv", label: "KV stores", list: () => inspectKVStores(build, dev, file) }],
          resources: () => inspectKVResources(options, projectRoot),
        }
      },
      // The Console, `vitehub kv`, and agents run these.
      operations: [{ export: "kvOperations", load: async () => (await import(/* @vite-ignore */ import.meta.url.endsWith(".ts") ? "./operations.ts" : "./operations.js")).kvOperations, module: operationsModule }],
      cli: async () => {
        const { createKVCliContributor } = await import(/* @vite-ignore */ "./cli.js")
        return {
          ...createKVCliContributor(),
          provision: [createKVCloudflareProvisionStep(() => options)],
        } satisfies ViteHubCliContributor
      },
    },
    config: {
      order: "pre",
      async handler(config, env) {
        command = env?.command ?? "build"
        mode = env?.mode ?? config.mode ?? (command === "serve" ? "development" : "production")
        runtimeConfig = undefined
        projectRoot = resolveViteHubProjectRoot(config.root || process.cwd())
        viteEnv = (await import("vite")).loadEnv(mode, config.envDir === false ? false : resolve(config.root || process.cwd(), config.envDir ?? "."), "")
        nitroOwned = configureNitroCloudflareKV(config, options, resolutionInput(), ownedNitroNamespaces, readProvisionStateSync(projectRoot))
        return installStandaloneOperationRpc(config, env?.command ?? "build", operationsModule)
      },
    },
    configResolved: {
      order: "pre",
      async handler(config) {
        resolved = config
        // The Nuxt replay passes a Vite config without `command`; the `config` hook already set it.
        if (config.command) command = config.command
        mode = config.mode ?? mode
        projectRoot = resolveViteHubProjectRoot(config.root || process.cwd())
        viteEnv = (await import("vite")).loadEnv(mode, config.envDir === false ? false : resolve(config.root || process.cwd(), config.envDir ?? "."), "")
        providerOutput = useProviderOutputCatalog(config)
        runtimeConfig = resolveKVViteConfig(options, resolutionInput())
        const provisionState = readProvisionStateSync(projectRoot)
        if (nitroOptions) reconcileNitroCloudflareKV(nitroOptions, runtimeConfig.kv, ownedNitroNamespaces, provisionState)
        if (hasNitroConfigContext(config) || isPlainObject(getResolvedNitroConfig(config))) {
          nitroOwned = configureNitroCloudflareKV(config, options, resolutionInput(), ownedNitroNamespaces, provisionState)
        }
      },
    },
    configureServer(server) {
      publishStandaloneOperationServer(server)
    },
    configEnvironment: {
      order: "pre",
      handler(name, config) {
        if (!isServerEnvironment(name, config)) return

        return {
          resolve: { noExternal: mergeNoExternal(config.resolve?.noExternal) },
        }
      },
    },
    resolveId: {
      order: "pre",
      handler(id, importer, resolveOptions) {
        if (id === UPSTASH_DRIVER_IMPORT_ID && resolveOptions?.ssr && !hasUpstashStore(getConfig().kv) && isKVOptionalUpstashImport(id, importer)) {
          return { external: true, id }
        }
        if (resolveOptions?.ssr && isUnstorageCloudflareWorkersImport(id, importer)) return { external: true, id }
        // `vite dev` uses the package runtime, which can fall back to `fs-lite` and prints the remote notice.
        if (id === "@vite-hub/kv" && command === "build" && isCloudflareKVConfig(getConfig().kv)) return RESOLVED_KV_RUNTIME_ID
        if (id === KV_VIRTUAL_CONFIG_ID) return RESOLVED_KV_VIRTUAL_CONFIG_ID
      },
    },
    load: {
      order: "pre",
      handler(id, options) {
        if (id === RESOLVED_KV_RUNTIME_ID) {
          const kv = getConfig().kv
          if (command === "build" && isCloudflareKVConfig(kv)) return serializeCloudflareRuntime(kv)
        }
        if (id === RESOLVED_KV_VIRTUAL_CONFIG_ID) return serializeVirtualConfig(getConfig(), command === "serve" && options?.ssr ? viteEnv : undefined)
      },
    },
    buildStart: {
      order: "pre",
      handler() {
        providerOutputGenerations.capture(this, providerOutput)
      },
    },
    buildEnd: {
      order: "pre",
      async handler(error) {
        if (error) {
          await providerOutputGenerations.reset(this, providerOutput, error)
          return
        }
        if (!resolved || shouldSkipViteProviderBuild(resolved.command, getViteMode())) return

        const rootDir = resolved.root
        const clientOutDir = resolved.build.outDir
        const wranglerConfig = nitroOwned ? undefined : createCloudflareKVWranglerConfig(getConfig().kv, readProvisionStateSync(projectRoot))
        const nextBindings = wranglerConfig?.kv_namespaces?.map(binding => binding.binding) ?? []
        const nitroNamespaces = nitroOwned
          ? [...new Map([
              ...getNitroCloudflareKVNamespaces(nitroOptions),
              ...getNitroCloudflareKVNamespaces(getResolvedNitroConfig(resolved)),
            ].map(namespace => [namespace.binding, namespace])).values()]
          : []
        const wranglerConfigOwnership = {
          arrays: {
            kv_namespaces: {
              key: "binding",
              retainOnCleanup: nitroNamespaces,
              values: nextBindings,
            },
          },
        }
        const wranglerConfigOwnershipFiles = {
          kv_namespaces: KV_CLOUDFLARE_BINDINGS_FILE,
        }
        contributeProviderDeploymentOutput(providerOutput, {
          owner: "kv",
          rootDir,
          write: async ({ write }) => await write({
            clientOutDir,
            rootDir,
            ...(wranglerConfig
              ? {
                  cloudflare: {
                    wranglerConfig,
                    wranglerConfigOwnership,
                    wranglerConfigOwnershipFiles,
                  },
                }
              : {
                  cleanup: {
                    cloudflare: {
                      requirePersistedOwnership: true,
                      wranglerConfigOwnership,
                      wranglerConfigOwnershipFiles,
                    },
                  },
                }),
          }),
        }, providerOutputGenerations.get(this))
      },
    },
    renderError: {
      order: "pre",
      async handler(error) {
        await providerOutputGenerations.reset(this, providerOutput, error)
      },
    },
    closeBundle: {
      order: "post",
      sequential: true,
      async handler() {
        if (!resolved || shouldSkipViteProviderBuild(resolved.command, getViteMode())) return
        await finalizeProviderDeploymentOutputs(providerOutput)
      },
    },
  }
}

