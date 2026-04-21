import { definePlugin as defineNitroPlugin } from "nitro"
import { useRuntimeConfig } from "nitro/runtime-config"
import { useStorage } from "nitro/storage"
import type { ResolvedKVModuleOptions } from "../types.ts"
import { createLazyKVRuntimeDriver } from "./driver.ts"

const kvNitroPlugin: ReturnType<typeof defineNitroPlugin> = defineNitroPlugin(async () => {
  const runtimeConfig = useRuntimeConfig() as {
    kv?: false | ResolvedKVModuleOptions
  }

  if (!runtimeConfig.kv) {
    return
  }

  const storage = useStorage()
  await storage.unmount("kv", false)
  storage.mount("kv", createLazyKVRuntimeDriver(runtimeConfig.kv))
})

export default kvNitroPlugin
