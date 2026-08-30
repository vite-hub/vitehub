import { createStorage } from "unstorage"
import createDriver from "unstorage/drivers/cloudflare-kv-binding"

import type { Driver } from "unstorage"

type CloudflareKVDriverOptions = Parameters<typeof createDriver>[0]

export function createCloudflareKVDriver(options: CloudflareKVDriverOptions): Driver {
  return createDriver(options)
}

export function createCloudflareKVStorage(options: CloudflareKVDriverOptions): unknown {
  return createStorage({ driver: createCloudflareKVDriver(options) })
}
