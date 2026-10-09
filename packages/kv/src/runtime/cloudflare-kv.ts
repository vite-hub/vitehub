import { getActiveCloudflareBinding } from "@vite-hub/internal/runtime/cloudflare-env"
import { createStorage } from "unstorage"
import createDriver from "unstorage/drivers/cloudflare-kv-binding"
import { normalizeKVListPrefix } from "./list-prefix.ts"
import { kvErrorDiagnostics } from "../error-diagnostics.ts"

import type { KVListOptions, KVListPage } from "../types.ts"
import type { KVRuntimeDriver } from "./driver.ts"

interface CloudflareKVNamespace {
  list: (options: { cursor?: string; limit: number; prefix?: string }) => Promise<unknown>
}

interface CloudflareKVListPage {
  cursor?: string
  keys: Array<{ name: string }>
  list_complete: boolean
}

function isCloudflareKVString(value: unknown): value is string {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Cloudflare list fields cross an untyped provider boundary.
  return typeof value === "string"
}

function isCloudflareKVListPage(value: unknown): value is CloudflareKVListPage {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Cloudflare bindings return unknown JavaScript values at this provider boundary.
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  // SAFETY: The guard reads only unknown properties and validates every field before returning true.
  const page = value as { cursor?: unknown; keys?: unknown; list_complete?: unknown }
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The provider page must expose a boolean completion marker before use.
  if (typeof page.list_complete !== "boolean" || !Array.isArray(page.keys)) return false
  if (!page.keys.every(key => {
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Each provider key is untyped JavaScript data at the Cloudflare binding boundary.
    if (!key || typeof key !== "object" || Array.isArray(key)) return false
    return isCloudflareKVString(Reflect.get(key, "name"))
  })) return false
  return page.list_complete || (isCloudflareKVString(page.cursor) && page.cursor.length > 0)
}

function createCloudflareDriver(options: Record<string, unknown>): KVRuntimeDriver {
  const bindingName = options.binding
  // unstorage reads `binding` on every operation and finds a binding name only on globals.
  // Resolve it from the active Cloudflare env first, because ViteHub workers scope env per request without the global `__env__`.
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The resolved store config crosses an untyped driver boundary.
  const driverOptions = typeof bindingName === "string"
    ? { ...options, get binding() { return getActiveCloudflareBinding<CloudflareKVNamespace>(bindingName) ?? bindingName } }
    : options
  // SAFETY: The unstorage Cloudflare driver exposes getInstance and this adapter installs listKeys before returning.
  const driver = createDriver(driverOptions) as KVRuntimeDriver & { getInstance: () => CloudflareKVNamespace }
  driver.listKeys = async ({ cursor, limit, prefix = "" }: KVListOptions): Promise<KVListPage> => {
    const listOptions: { cursor?: string; limit: number; prefix?: string } = { limit }
    if (cursor) listOptions.cursor = cursor
    if (prefix) listOptions.prefix = prefix
    const page = await driver.getInstance().list(listOptions)
    if (!isCloudflareKVListPage(page)) {
      throw kvErrorDiagnostics.KV_R0022({ message: "[vitehub] Cloudflare KV list returned an invalid page." })
    }
    const result: KVListPage = { keys: page.keys.map((key: { name: string }) => key.name) }
    if (!page.list_complete) result.cursor = page.cursor
    return result
  }
  return driver
}

export function createCloudflareKVStorage(options: Record<string, unknown>): unknown {
  const driver = createCloudflareDriver(options)
  // doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- The storage object is extended only with the driver-backed listKeys method.
  // SAFETY: createStorage returns an extensible storage object; listKeys is installed before it escapes.
  const storage = createStorage({ driver }) as unknown as Record<string, unknown>
  storage.listKeys = (listOptions: KVListOptions) => driver.listKeys({ ...listOptions, prefix: normalizeKVListPrefix(listOptions.prefix) })
  return storage
}

export default createCloudflareDriver
