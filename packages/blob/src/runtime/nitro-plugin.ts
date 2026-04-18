import { defineNitroPlugin, useRuntimeConfig } from "nitro/runtime"
import { setBlobRuntimeConfig } from "./state.ts"
import type { ResolvedBlobModuleOptions } from "../types.ts"

const blobNitroPlugin: ReturnType<typeof defineNitroPlugin> = defineNitroPlugin(() => {
  const runtimeConfig = useRuntimeConfig() as {
    blob?: false | ResolvedBlobModuleOptions
  }
  setBlobRuntimeConfig(runtimeConfig.blob)
  ;(globalThis as typeof globalThis & { __vitehubBlobConfig?: false | ResolvedBlobModuleOptions }).__vitehubBlobConfig = runtimeConfig.blob
})

export default blobNitroPlugin
