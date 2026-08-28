import { createStorage } from "unstorage"
import createDriver from "unstorage/drivers/cloudflare-kv-binding"

export function createCloudflareKVStorage(options: Record<string, unknown>): unknown {
  return createStorage({ driver: createDriver(options) })
}
