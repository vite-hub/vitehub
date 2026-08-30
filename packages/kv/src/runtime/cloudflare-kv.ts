import { createStorage } from "unstorage"
import createDriver from "unstorage/drivers/cloudflare-kv-binding"

import type { KVListOptions, KVListPage } from "../types.ts"
import type { KVRuntimeDriver } from "./driver.ts"

interface CloudflareKVNamespace {
  list: (options: { cursor?: string; limit: number; prefix?: string }) => Promise<{
    cursor?: string
    keys: Array<{ name: string }>
    list_complete: boolean
  }>
}

function createCloudflareDriver(options: Record<string, unknown>): KVRuntimeDriver {
  // SAFETY: The unstorage Cloudflare driver exposes getInstance and this adapter installs listKeys before returning.
  const driver = createDriver(options) as KVRuntimeDriver & { getInstance: () => CloudflareKVNamespace }
  driver.listKeys = async ({ cursor, limit, prefix = "" }: KVListOptions): Promise<KVListPage> => {
    const listOptions: { cursor?: string; limit: number; prefix?: string } = { limit }
    if (cursor) listOptions.cursor = cursor
    if (prefix) listOptions.prefix = prefix
    const page = await driver.getInstance().list(listOptions)
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
  storage.listKeys = (listOptions: KVListOptions) => driver.listKeys(listOptions)
  return storage
}

export default createCloudflareDriver
