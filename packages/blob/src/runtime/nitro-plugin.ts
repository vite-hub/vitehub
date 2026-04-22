import { definePlugin as defineNitroPlugin } from "nitro"
import { useRuntimeConfig } from "nitro/runtime-config"

import { setActiveCloudflareEnv, setBlobRuntimeConfig } from "./state.ts"

import type { ResolvedBlobModuleOptions } from "../types.ts"

const blobNitroPlugin: ReturnType<typeof defineNitroPlugin> = defineNitroPlugin((nitroApp: any) => {
  const runtimeConfig = useRuntimeConfig() as {
    blob?: false | ResolvedBlobModuleOptions
  }

  const applyRuntimeState = (event?: { context?: { cloudflare?: { env?: Record<string, unknown> } } }) => {
    setBlobRuntimeConfig(runtimeConfig.blob)
    setActiveCloudflareEnv(event?.context?.cloudflare?.env)
  }

  applyRuntimeState()
  nitroApp.hooks.hook("request", (event: any) => {
    applyRuntimeState(event)
  })
})

export default blobNitroPlugin
