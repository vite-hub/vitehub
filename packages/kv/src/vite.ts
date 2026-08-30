import {
  KV_VIRTUAL_CONFIG_ID,
  KV_VITE_PLUGIN_NAME,
  resolveKVViteConfig,
} from "./vite-config.ts"

import {
  contributeProviderDeploymentOutput,
  createProviderDeploymentOutputGenerationState,
  finalizeProviderDeploymentOutputs,
  useProviderOutputCatalog,
} from "@vite-hub/internal/build/deployment-output"
import { getViteMode } from "@vite-hub/internal/build/mode"
import { createNoExternalMerger, hasNitroConfigContext, isServerEnvironment, shouldSkipViteProviderBuild } from "@vite-hub/internal/build/vite"
import { isPlainObject } from "@vite-hub/internal/object"

import { configureCloudflareKV } from "./integrations/cloudflare.ts"

import type { KVViteRuntimeConfig } from "./vite-config.ts"
import type { KVModuleOptions, ResolvedKVModuleOptions } from "./types.ts"
import type { Plugin, ResolvedConfig } from "vite"

const RESOLVED_KV_VIRTUAL_CONFIG_ID = `\0${KV_VIRTUAL_CONFIG_ID}`
const KV_RUNTIME_ID = "#vitehub/kv/runtime"
const RESOLVED_KV_RUNTIME_ID = `\0${KV_RUNTIME_ID}`
const KV_ERRORS_IMPORT_ID = new URL(import.meta.url.endsWith(".ts") ? "./errors.ts" : "./errors.js", import.meta.url).href
const UPSTASH_DRIVER_IMPORT_ID = "@vite-hub/kv/runtime/upstash-driver"
const CLOUDFLARE_KV_RUNTIME_IMPORT_ID = "@vite-hub/kv/runtime/cloudflare-kv"
const mergeNoExternal = createNoExternalMerger("@vite-hub/kv")
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
}

export function hubKvOptionalPeerResolver(): Plugin {
  return {
    name: "@vite-hub/kv/optional-peers",
    enforce: "pre",
    resolveId(id, importer, resolveOptions) {
      if (!resolveOptions?.ssr || !isKVOptionalUpstashImport(id, importer)) return
      return { external: true, id }
    },
  }
}

function serializeVirtualConfig(config: KVViteRuntimeConfig): string {
  return [
    `export const hosting = ${JSON.stringify(config.hosting)};`,
    `export const kv = ${JSON.stringify(config.kv)};`,
    "export default { hosting, kv };",
  ].join("\n")
}

function isCloudflareKVConfig(kv: KVViteRuntimeConfig["kv"]): kv is ResolvedKVModuleOptions {
  if (!kv) return false
  return Object.values(kv.stores || { default: kv.store })
    .every(store => store.driver === "cloudflare-kv-binding")
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

function createCloudflareKVWranglerConfig(kv: KVViteRuntimeConfig["kv"]) {
  if (!kv) return
  const target: { cloudflare?: { wrangler?: { kv_namespaces?: Array<{ binding: string, id?: string }> } } } = {}
  configureCloudflareKV(target, kv)
  return target.cloudflare?.wrangler?.kv_namespaces?.length ? target.cloudflare.wrangler : undefined
}

function serializeCloudflareRuntime(config: ResolvedKVModuleOptions): string {
  return [
    `import { createCloudflareKVStorage } from ${JSON.stringify(CLOUDFLARE_KV_RUNTIME_IMPORT_ID)};`,
    `import { kvResult } from ${JSON.stringify(KV_ERRORS_IMPORT_ID)};`,
    "",
    `const kvConfig = ${JSON.stringify(config, null, 2)}`,
    "const storages = new Map();",
    "",
    "function resolveStoreConfig(name) {",
    "  const stores = kvConfig.stores || { default: kvConfig.store };",
    "  const store = stores[name];",
    "  if (!store) throw new Error(`[vitehub] Unknown KV store \"${name}\".`);",
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
    "async function resolveStorageResult(name, operation) {",
    "  resolveStoreConfig(name);",
    "  return kvResult(operation, name, async () => resolveStorage(name));",
    "}",
    "",
    "function createKVStorage(name = \"default\") {",
    "  return {",
    "    async clear(base, options) { const [error, storage] = await resolveStorageResult(name, \"clear\"); return error ? [error, undefined] : kvResult(\"clear\", name, async () => { await storage.clear(base, options); }); },",
    "    async del(key, options) { const [error, storage] = await resolveStorageResult(name, \"del\"); return error ? [error, undefined] : kvResult(\"del\", name, async () => { await storage.removeItem(key, options); }); },",
    "    async get(key, options) { const [error, storage] = await resolveStorageResult(name, \"get\"); return error ? [error, undefined] : kvResult(\"get\", name, () => storage.getItem(key, options)); },",
    "    async has(key, options) { const [error, storage] = await resolveStorageResult(name, \"has\"); return error ? [error, undefined] : kvResult(\"has\", name, () => storage.hasItem(key, options)); },",
    "    async keys(base, options) { const [error, storage] = await resolveStorageResult(name, \"keys\"); return error ? [error, undefined] : kvResult(\"keys\", name, () => storage.getKeys(base, options)); },",
    "    async list(options) { if (!Number.isInteger(options.limit) || options.limit <= 0) throw new TypeError(\"`limit` must be a positive integer.\"); const [error, storage] = await resolveStorageResult(name, \"list\"); return error ? [error, undefined] : kvResult(\"list\", name, () => storage.listKeys(options)); },",
    "    async set(key, value, options) { const [error, storage] = await resolveStorageResult(name, \"set\"); return error ? [error, undefined] : kvResult(\"set\", name, async () => { await storage.setItem(key, value, options); }); },",
    "    store(storeName) { return createKVStorage(storeName); },",
    "  };",
    "}",
    "",
    "export const kv = createKVStorage();",
    "",
  ].join("\n")
}

interface NitroCloudflareKVTarget {
  cloudflare?: {
    wrangler?: {
      kv_namespaces?: Array<{ binding: string, id?: string }>
    }
  }
}

function reconcileNitroCloudflareKV(
  target: NitroCloudflareKVTarget,
  kv: KVViteRuntimeConfig["kv"],
  ownedNamespaces: Set<{ binding: string, id?: string }>,
): void {
  const namespaces = target.cloudflare?.wrangler?.kv_namespaces
  if (namespaces?.length && ownedNamespaces.size) {
    for (const owned of ownedNamespaces) {
      const ownedIndex = namespaces.findIndex(namespace => namespace.binding === owned.binding && namespace.id === owned.id)
      if (ownedIndex !== -1) namespaces.splice(ownedIndex, 1)
    }
  }
  if (kv) configureCloudflareKV(target, kv)
}

function configureNitroCloudflareKV(
  config: { kv?: KVModuleOptions, nitro?: unknown },
  options: KVModuleOptions | undefined,
  ownedNamespaces: Set<{ binding: string, id?: string }>,
): boolean {
  const { nitro } = config
  if (!isPlainObject(nitro)) return false

  // SAFETY: Vite's Nitro config is an open plain object; this function owns only the optional Cloudflare Wrangler fields below.
  const target = nitro as NitroCloudflareKVTarget
  const namespaces = target.cloudflare?.wrangler?.kv_namespaces
  if (namespaces && ownedNamespaces.size) {
    target.cloudflare!.wrangler!.kv_namespaces = namespaces.filter(namespace => !ownedNamespaces.has(namespace))
  }
  ownedNamespaces.clear()

  const kv = resolveKVViteConfig(config.kv ?? options).kv
  if (kv) {
    const existingNamespaces = new Set(target.cloudflare?.wrangler?.kv_namespaces)
    configureCloudflareKV(target, kv)
    for (const namespace of target.cloudflare?.wrangler?.kv_namespaces ?? []) {
      if (!existingNamespaces.has(namespace)) ownedNamespaces.add(namespace)
    }
  }
  return true
}

export function hubKv(options?: KVModuleOptions): KVVitePlugin {
  let nitroOwned = false
  let nitroOptions: NitroCloudflareKVTarget | undefined
  const ownedNitroNamespaces = new Set<{ binding: string, id?: string }>()
  let resolved: ResolvedConfig | undefined
  let providerOutput: ReturnType<typeof useProviderOutputCatalog> | undefined
  let runtimeConfig: KVViteRuntimeConfig | undefined
  const getConfig = () => runtimeConfig ??= resolveKVViteConfig(options)
  const providerOutputGenerations = createProviderDeploymentOutputGenerationState()

  return {
    name: KV_VITE_PLUGIN_NAME,
    enforce: "post",
    api: { getConfig },
    nitro: {
      name: "@vite-hub/kv/cloudflare-bindings",
      setup(nitro) {
        nitroOptions = nitro.options
        if (runtimeConfig) reconcileNitroCloudflareKV(nitroOptions, runtimeConfig.kv, ownedNitroNamespaces)
      },
    },
    config: {
      order: "pre",
      handler(config) {
        nitroOwned = configureNitroCloudflareKV(config, options, ownedNitroNamespaces)
      },
    },
    configResolved: {
      order: "pre",
      handler(config) {
        resolved = config
        providerOutput = useProviderOutputCatalog(config)
        runtimeConfig = resolveKVViteConfig(config.kv ?? options)
        if (nitroOptions) reconcileNitroCloudflareKV(nitroOptions, runtimeConfig.kv, ownedNitroNamespaces)
        if (hasNitroConfigContext(config)) nitroOwned = configureNitroCloudflareKV(config, options, ownedNitroNamespaces)
      },
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
        if (id === "@vite-hub/kv" && isCloudflareKVConfig(getConfig().kv)) return RESOLVED_KV_RUNTIME_ID
        if (id === KV_VIRTUAL_CONFIG_ID) return RESOLVED_KV_VIRTUAL_CONFIG_ID
      },
    },
    load: {
      order: "pre",
      handler(id) {
        if (id === RESOLVED_KV_RUNTIME_ID) {
          const kv = getConfig().kv
          if (isCloudflareKVConfig(kv)) return serializeCloudflareRuntime(kv)
        }
        if (id === RESOLVED_KV_VIRTUAL_CONFIG_ID) return serializeVirtualConfig(getConfig())
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
        const wranglerConfig = nitroOwned ? undefined : createCloudflareKVWranglerConfig(getConfig().kv)
        const nextBindings = wranglerConfig?.kv_namespaces?.map(binding => binding.binding) ?? []
        const wranglerConfigOwnership = {
          arrays: {
            kv_namespaces: {
              key: "binding",
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

declare module "vite" {
  interface UserConfig {
    kv?: KVModuleOptions
  }
}
