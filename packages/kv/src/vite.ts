import {
  KV_VIRTUAL_CONFIG_ID,
  KV_VITE_PLUGIN_NAME,
  resolveKVViteConfig,
} from "./vite-config.ts"

import { writeCloudflareWranglerConfig } from "@vite-hub/internal/build/cloudflare"
import { getViteMode } from "@vite-hub/internal/build/mode"
import { createNoExternalMerger, isServerEnvironment, shouldSkipViteProviderBuild } from "@vite-hub/internal/build/vite"

import { configureCloudflareKV } from "./integrations/cloudflare.ts"

import type { KVViteRuntimeConfig } from "./vite-config.ts"
import type { KVModuleOptions, ResolvedKVModuleOptions } from "./types.ts"
import type { Plugin, ResolvedConfig } from "vite"

const RESOLVED_KV_VIRTUAL_CONFIG_ID = `\0${KV_VIRTUAL_CONFIG_ID}`
const KV_RUNTIME_ID = "#vitehub/kv/runtime"
const RESOLVED_KV_RUNTIME_ID = `\0${KV_RUNTIME_ID}`
const UNSTORAGE_IMPORT_ID = import.meta.resolve("unstorage")
const CLOUDFLARE_KV_DRIVER_IMPORT_ID = import.meta.resolve("unstorage/drivers/cloudflare-kv-binding")
const mergeNoExternal = createNoExternalMerger("@vite-hub/kv")

export { KV_VIRTUAL_CONFIG_ID, KV_VITE_PLUGIN_NAME, resolveKVViteConfig }
export type { KVViteRuntimeConfig } from "./vite-config.ts"

export interface KVVitePluginAPI {
  getConfig: () => KVViteRuntimeConfig
}

export type KVVitePlugin = Plugin & { api: KVVitePluginAPI }

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

function createCloudflareKVWranglerConfig(kv: KVViteRuntimeConfig["kv"]) {
  if (!kv) return
  const target: { cloudflare?: { wrangler?: { kv_namespaces?: Array<{ binding: string, id?: string }> } } } = {}
  configureCloudflareKV(target, kv)
  return target.cloudflare?.wrangler?.kv_namespaces?.length ? target.cloudflare.wrangler : undefined
}

function serializeCloudflareRuntime(config: ResolvedKVModuleOptions): string {
  return [
    `import { createStorage } from ${JSON.stringify(UNSTORAGE_IMPORT_ID)};`,
    `import createDriver from ${JSON.stringify(CLOUDFLARE_KV_DRIVER_IMPORT_ID)};`,
    "",
    `const kvConfig = ${JSON.stringify(config, null, 2)}`,
    "const storages = new Map();",
    "",
    "function resolveStorage(name = \"default\") {",
    "  const stores = kvConfig.stores || { default: kvConfig.store };",
    "  const store = stores[name];",
    "  if (!store) throw new Error(`[vitehub] Unknown KV store \"${name}\".`);",
    "  const existing = storages.get(name);",
    "  if (existing) return existing;",
    "  const storage = createStorage({ driver: createDriver(store) });",
    "  storages.set(name, storage);",
    "  return storage;",
    "}",
    "",
    "function createKVStorage(name = \"default\") {",
    "  return {",
    "    async clear(base, options) { await resolveStorage(name).clear(base, options); },",
    "    async del(key, options) { await resolveStorage(name).removeItem(key, options); },",
    "    async get(key, options) { return await resolveStorage(name).getItem(key, options); },",
    "    async has(key, options) { return await resolveStorage(name).hasItem(key, options); },",
    "    async keys(base, options) { return await resolveStorage(name).getKeys(base, options); },",
    "    async set(key, value, options) { await resolveStorage(name).setItem(key, value, options); },",
    "    store(storeName) { return createKVStorage(storeName); },",
    "  };",
    "}",
    "",
    "export const kv = createKVStorage();",
    "",
  ].join("\n")
}

export function hubKv(options?: KVModuleOptions): KVVitePlugin {
  let resolved: ResolvedConfig | undefined
  let runtimeConfig: KVViteRuntimeConfig | undefined
  const getConfig = () => runtimeConfig ??= resolveKVViteConfig(options)

  return {
    name: KV_VITE_PLUGIN_NAME,
    enforce: "pre",
    api: { getConfig },
    configResolved(config) {
      resolved = config
      runtimeConfig = resolveKVViteConfig(config.kv ?? options)
    },
    configEnvironment(name, config) {
      if (!isServerEnvironment(name, config)) {
        return
      }

      return {
        resolve: { noExternal: mergeNoExternal(config.resolve?.noExternal) },
      }
    },
    resolveId(id) {
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

        await writeCloudflareWranglerConfig({
          rootDir: resolved.root,
          wranglerConfig: createCloudflareKVWranglerConfig(getConfig().kv),
          wranglerConfigKeys: ["kv_namespaces"],
        })
      },
    },
  }
}

declare module "vite" {
  interface UserConfig {
    kv?: KVModuleOptions
  }
}
