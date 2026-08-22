import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import {
  KV_VIRTUAL_CONFIG_ID,
  KV_VITE_PLUGIN_NAME,
  resolveKVViteConfig,
} from "./vite-config.ts"

import { createDefaultCloudflareOutputRoot, writeCloudflareWranglerConfig } from "@vite-hub/internal/build/cloudflare"
import { getViteMode } from "@vite-hub/internal/build/mode"
import { createNoExternalMerger, hasNitroConfigContext, isServerEnvironment, shouldSkipViteProviderBuild } from "@vite-hub/internal/build/vite"

import { configureCloudflareKV } from "./integrations/cloudflare.ts"

import type { KVViteRuntimeConfig } from "./vite-config.ts"
import type { KVModuleOptions, ResolvedKVModuleOptions } from "./types.ts"
import type { Plugin, ResolvedConfig } from "vite"

const RESOLVED_KV_VIRTUAL_CONFIG_ID = `\0${KV_VIRTUAL_CONFIG_ID}`
const KV_RUNTIME_ID = "#vitehub/kv/runtime"
const RESOLVED_KV_RUNTIME_ID = `\0${KV_RUNTIME_ID}`
const KV_ERRORS_IMPORT_ID = new URL(import.meta.url.endsWith(".ts") ? "./errors.ts" : "./errors.js", import.meta.url).href
const UPSTASH_DRIVER_IMPORT_ID = "@vite-hub/kv/runtime/upstash-driver"
const UNSTORAGE_IMPORT_ID = import.meta.resolve("unstorage")
const CLOUDFLARE_KV_DRIVER_IMPORT_ID = import.meta.resolve("unstorage/drivers/cloudflare-kv-binding")
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
  return Boolean(kv) && Object.values((kv as ResolvedKVModuleOptions).stores || { default: (kv as ResolvedKVModuleOptions).store })
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

function cloudflareBindingsFile(rootDir: string) {
  return join(createDefaultCloudflareOutputRoot(rootDir), KV_CLOUDFLARE_BINDINGS_FILE)
}

async function readOwnedCloudflareKVBindings(rootDir: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(cloudflareBindingsFile(rootDir), "utf8"))
    return Array.isArray(parsed) ? parsed.filter(value => typeof value === "string") : []
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
}

async function writeOwnedCloudflareKVBindings(rootDir: string, bindings: string[]): Promise<void> {
  const file = cloudflareBindingsFile(rootDir)
  if (!bindings.length) {
    await rm(file, { force: true })
    return
  }
  await mkdir(createDefaultCloudflareOutputRoot(rootDir), { recursive: true })
  await writeFile(file, `${JSON.stringify([...new Set(bindings)], null, 2)}\n`, "utf8")
}

function serializeCloudflareRuntime(config: ResolvedKVModuleOptions): string {
  return [
    `import { createStorage } from ${JSON.stringify(UNSTORAGE_IMPORT_ID)};`,
    `import createDriver from ${JSON.stringify(CLOUDFLARE_KV_DRIVER_IMPORT_ID)};`,
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
    "  const storage = createStorage({ driver: createDriver(store) });",
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
  if (!nitro || typeof nitro !== "object" || Array.isArray(nitro)) return false

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
  let runtimeConfig: KVViteRuntimeConfig | undefined
  const getConfig = () => runtimeConfig ??= resolveKVViteConfig(options)

  return {
    name: KV_VITE_PLUGIN_NAME,
    enforce: "pre",
    api: { getConfig },
    nitro: {
      name: "@vite-hub/kv/cloudflare-bindings",
      setup(nitro) {
        nitroOptions = nitro.options
        if (runtimeConfig) reconcileNitroCloudflareKV(nitroOptions, runtimeConfig.kv, ownedNitroNamespaces)
      },
    },
    config(config) {
      nitroOwned = configureNitroCloudflareKV(config, options, ownedNitroNamespaces)
    },
    configResolved(config) {
      resolved = config
      runtimeConfig = resolveKVViteConfig(config.kv ?? options)
      if (nitroOptions) reconcileNitroCloudflareKV(nitroOptions, runtimeConfig.kv, ownedNitroNamespaces)
      if (hasNitroConfigContext(config)) nitroOwned = configureNitroCloudflareKV(config, options, ownedNitroNamespaces)
    },
    configEnvironment(name, config) {
      if (!isServerEnvironment(name, config)) {
        return
      }

      return {
        resolve: { noExternal: mergeNoExternal(config.resolve?.noExternal) },
      }
    },
    resolveId(id, importer, resolveOptions) {
      if (id === UPSTASH_DRIVER_IMPORT_ID && resolveOptions?.ssr && !hasUpstashStore(getConfig().kv) && isKVOptionalUpstashImport(id, importer)) {
        return { external: true, id }
      }
      if (id === "@vite-hub/kv" && isCloudflareKVConfig(getConfig().kv)) return RESOLVED_KV_RUNTIME_ID
      if (id === KV_VIRTUAL_CONFIG_ID) return RESOLVED_KV_VIRTUAL_CONFIG_ID
    },
    load(id) {
      if (id === RESOLVED_KV_RUNTIME_ID) {
        const kv = getConfig().kv
        if (isCloudflareKVConfig(kv)) return serializeCloudflareRuntime(kv)
      }
      if (id === RESOLVED_KV_VIRTUAL_CONFIG_ID) return serializeVirtualConfig(getConfig())
    },
    closeBundle: {
      order: "post",
      sequential: true,
      async handler() {
        if (!resolved || shouldSkipViteProviderBuild(resolved.command, getViteMode())) return

        const wranglerConfig = nitroOwned ? undefined : createCloudflareKVWranglerConfig(getConfig().kv)
        const nextBindings = wranglerConfig?.kv_namespaces?.map(binding => binding.binding) ?? []
        const previousBindings = await readOwnedCloudflareKVBindings(resolved.root)
        if (!wranglerConfig && !previousBindings.length) return

        await writeCloudflareWranglerConfig({
          rootDir: resolved.root,
          wranglerConfigOwnership: {
            arrays: {
              kv_namespaces: {
                key: "binding",
                values: [...previousBindings, ...nextBindings],
              },
            },
          },
          ...(wranglerConfig ? { wranglerConfig } : {}),
        })
        await writeOwnedCloudflareKVBindings(resolved.root, nextBindings)
      },
    },
  }
}

declare module "vite" {
  interface UserConfig {
    kv?: KVModuleOptions
  }
}
