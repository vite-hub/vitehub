import { useRuntimeConfig } from "nitro/runtime-config"
import { useStorage } from "nitro/storage"
import type { ResolvedKVModuleOptions } from "../types.ts"
import { createKVRuntimeDriver } from "./driver.ts"
import { resolveRuntimeKVOptions } from "./upstash.ts"

const kvNitroPlugin = async (): Promise<void> => {
  const runtimeConfig = useRuntimeConfig() as {
    kv?: false | ResolvedKVModuleOptions
  }
  const resolved = resolveRuntimeKVOptions(runtimeConfig.kv)

  if (!resolved) {
    return
  }

  const storage = useStorage()
  await storage.unmount("kv", false)
  storage.mount("kv", await createKVRuntimeDriver(resolved.store))
}

export default kvNitroPlugin
