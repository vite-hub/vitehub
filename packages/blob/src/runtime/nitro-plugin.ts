import { definePlugin as defineNitroPlugin } from "nitro"
import { useRuntimeConfig } from "nitro/runtime-config"

import { clearActiveCloudflareEnv, runWithActiveCloudflareEnv, setBlobRuntimeConfig } from "./state.ts"

import type { ResolvedBlobModuleOptions } from "../types.ts"

const blobNitroPlugin: ReturnType<typeof defineNitroPlugin> = defineNitroPlugin((nitroApp: any) => {
  const runtimeConfig = useRuntimeConfig() as {
    blob?: false | ResolvedBlobModuleOptions
  }

  const applyRuntimeState = () => {
    setBlobRuntimeConfig(runtimeConfig.blob)
  }

  applyRuntimeState()
  const originalFetch = typeof nitroApp.fetch === "function" ? nitroApp.fetch.bind(nitroApp) : undefined
  if (originalFetch) {
    nitroApp.fetch = (request: { context?: { cloudflare?: { env?: Record<string, unknown> } } }) => {
      applyRuntimeState()
      const env = request?.context?.cloudflare?.env
      if (!env) {
        return originalFetch(request)
      }

      return runWithActiveCloudflareEnv(env, async () => {
        try {
          return await originalFetch(request)
        }
        finally {
          clearActiveCloudflareEnv()
        }
      })
    }
  }

  nitroApp.hooks.hook("request", () => {
    applyRuntimeState()
  })
})

export default blobNitroPlugin
