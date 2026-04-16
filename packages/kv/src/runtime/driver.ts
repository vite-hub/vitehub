import type { Driver } from "unstorage"

import type { ResolvedKVStoreConfig } from "../types.ts"

type DriverFactory = (options: object) => Driver

const driverLoaders = {
  "cloudflare-kv-binding": () => import("unstorage/drivers/cloudflare-kv-binding"),
  "fs-lite": () => import("unstorage/drivers/fs-lite"),
  "upstash": () => import("unstorage/drivers/upstash"),
} satisfies Record<ResolvedKVStoreConfig["driver"], () => Promise<{ default: DriverFactory }>>

async function loadDriverFactory(driver: ResolvedKVStoreConfig["driver"]) {
  const module = await driverLoaders[driver]()
  return module.default
}

export async function createKVRuntimeDriver(
  config: ResolvedKVStoreConfig,
): Promise<Driver> {
  const createDriver = await loadDriverFactory(config.driver)
  return createDriver(config)
}
