import { useRuntimeConfig } from "nitropack/runtime/config"
import { useStorage } from "nitropack/runtime/storage"
import type { ResolvedKVModuleOptions } from "../types.ts"
import { createKVRuntimeDriver } from "./driver.ts"
import { resolveRuntimeKVOptions } from "./upstash.ts"

const kvNitropackPlugin = async (): Promise<void> => {
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

export default kvNitropackPlugin
