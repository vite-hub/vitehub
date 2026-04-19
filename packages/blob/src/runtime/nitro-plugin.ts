import { useRuntimeConfig } from "nitro/runtime-config"
import { setBlobRuntimeConfig, setBlobRuntimeHosting } from "./state.ts"
import type { ResolvedBlobModuleOptions } from "../types.ts"

type BlobGlobals = typeof globalThis & {
  __vitehubBlobConfig?: false | ResolvedBlobModuleOptions
  __vitehubBlobHosting?: string
}

function blobNitroPlugin(): void {
  const runtimeConfig = useRuntimeConfig() as {
    blob?: false | ResolvedBlobModuleOptions
    hosting?: string
  }
  setBlobRuntimeConfig(runtimeConfig.blob)
  setBlobRuntimeHosting(runtimeConfig.hosting)
  const globals = globalThis as BlobGlobals
  globals.__vitehubBlobConfig = runtimeConfig.blob
  globals.__vitehubBlobHosting = runtimeConfig.hosting
}

export default blobNitroPlugin
