import { useRuntimeConfig } from "nitro/runtime-config"
import { setBlobRuntimeConfig } from "./state.ts"
import type { ResolvedBlobModuleOptions } from "../types.ts"

type BlobGlobals = typeof globalThis & {
  __vitehubBlobConfig?: false | ResolvedBlobModuleOptions
  __vitehubBlobHosting?: string
}

export default function blobNitroPlugin(): void {
  const runtimeConfig = useRuntimeConfig() as {
    blob?: false | ResolvedBlobModuleOptions
    hosting?: string
  }
  setBlobRuntimeConfig(runtimeConfig.blob)
  const globals = globalThis as BlobGlobals
  globals.__vitehubBlobConfig = runtimeConfig.blob
  globals.__vitehubBlobHosting = runtimeConfig.hosting
}
