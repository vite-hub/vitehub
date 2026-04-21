import { definePlugin as defineNitroPlugin } from "nitro"
import { useRuntimeConfig } from "nitro/runtime-config"
import { useStorage } from "nitro/storage"
import { createStorage } from "unstorage"
import type { ResolvedKVModuleOptions } from "../types.ts"
import { createLazyKVRuntimeDriver } from "./driver.ts"

const kvNitroPlugin: ReturnType<typeof defineNitroPlugin> = defineNitroPlugin(() => {
  const runtimeConfig = useRuntimeConfig() as {
    kv?: false | ResolvedKVModuleOptions
  }

  if (!runtimeConfig.kv) {
    return
  }

  const storage = useStorage()
  const rootMount = storage.getMount("")?.driver
  const nextStorage = createStorage(rootMount ? { driver: rootMount } : {})

  for (const mount of storage.getMounts()) {
    if (mount.base === "" || mount.base === "kv:") {
      continue
    }
    nextStorage.mount(mount.base, mount.driver)
  }

  nextStorage.mount("kv", createLazyKVRuntimeDriver(runtimeConfig.kv))
  ;(useStorage as typeof useStorage & { _storage?: typeof nextStorage })._storage = nextStorage
})

export default kvNitroPlugin
