import { describe, expectTypeOf, it } from "vitest"
import type { NitroRuntimeConfig } from "nitro/types"

import "../src/nitro.ts"
import { defineChat, type ChatModuleOptions } from "@vitehub/chat"
import {
  defineCloudflareChatHandler,
  type CloudflareExportedHandlerFetchHandler,
} from "@vitehub/chat/cloudflare"

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

  it("types chat agent bindings and hooks", () => {
    defineChat({
      adapters: {},
      agent: "triager",
      state: {} as never,
    })

    defineChat({
      adapters: {},
      agent: {
        hooks: {
          prepareInput({ history, message, runtimeConfig, thread }) {
            expectTypeOf(history).toMatchTypeOf<Array<{ role: string }>>()
            expectTypeOf(message.text).toEqualTypeOf<string>()
            expectTypeOf(runtimeConfig.telegram.botToken).toEqualTypeOf<string>()
            expectTypeOf(thread.id).toEqualTypeOf<string>()
            return { messages: history }
          },
        },
        name: "triager",
      },
      state: {} as never,
    })
  })

  it("accepts dev initialization options", () => {
    expectTypeOf<ChatModuleOptions["dev"]>().toEqualTypeOf<false | { devtools?: boolean | { url?: string }, initialize?: boolean, localStateFallback?: boolean } | undefined>()
  })
})
