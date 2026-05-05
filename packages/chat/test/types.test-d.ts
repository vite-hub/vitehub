import { describe, expectTypeOf, it } from "vitest"
import type { NitroRuntimeConfig } from "nitro/types"

import "../src/nitro.ts"
import { defineChat, type ChatModuleOptions } from "@vitehub/chat"
import {
  defineCloudflareChatHandler,
  type CloudflareExportedHandlerFetchHandler,
} from "@vitehub/chat/cloudflare"
import type { PluginWithDevTools } from "@vitejs/devtools-kit"
import type { NitroModule } from "nitro/types"
import { chatDevtools, hubChat } from "../src/vite.ts"

declare module "nitro/types" {
  interface NitroRuntimeConfig {
    telegram: {
      apiBaseUrl: string | undefined
      botToken: string
    }
  }
}

describe("Nitro runtime config types", () => {
  it("publishes self-contained cloudflare subpath types", () => {
    expectTypeOf(defineCloudflareChatHandler({} as never)).toMatchTypeOf<CloudflareExportedHandlerFetchHandler<Record<string, unknown>>>()
  })

  it("types defineChat runtimeConfig from Nitro runtime config", () => {
    expectTypeOf<NitroRuntimeConfig["telegram"]["botToken"]>().toEqualTypeOf<string>()

    defineChat({
      adapters({ runtimeConfig }) {
        expectTypeOf(runtimeConfig.telegram.apiBaseUrl).toEqualTypeOf<string | undefined>()
        expectTypeOf(runtimeConfig.telegram.botToken).toEqualTypeOf<string>()
        return {}
      },
      state: {} as never,
    })
  })

  it("accepts dev initialization options", () => {
    expectTypeOf<ChatModuleOptions["dev"]>().toEqualTypeOf<false | { devtools?: boolean | { url?: string }, initialize?: boolean, localStateFallback?: boolean } | undefined>()
  })

  it("publishes separate Vite plugin types for Chat DevTools and full Chat integration", () => {
    expectTypeOf(chatDevtools()).toMatchTypeOf<PluginWithDevTools & { nitro?: never }>()
    expectTypeOf(hubChat()).toMatchTypeOf<PluginWithDevTools & { nitro: NitroModule }>()
  })
})
