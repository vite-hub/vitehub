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
  await storage.unmount("kv")
  storage.mount("kv", createLazyKVRuntimeDriver(runtimeConfig.kv))

  const stores = runtimeConfig.kv.stores || { default: runtimeConfig.kv.store }
  for (const [name, store] of Object.entries(stores)) {
    if (name === "default") continue
    await storage.unmount(`kv:${name}`)
    storage.mount(`kv:${name}`, createLazyKVRuntimeDriver({ store, stores: { default: store, [name]: store } }))
  }
})

export default kvNitroPlugin
