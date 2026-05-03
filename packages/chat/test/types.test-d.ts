import { describe, expectTypeOf, it } from "vitest"
import type { NitroRuntimeConfig } from "nitro/types"

import "../src/nitro.ts"
import { defineChat } from "@vitehub/chat"
import {
  ChatStateDO,
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
    expectTypeOf<typeof ChatStateDO>().toMatchTypeOf<new (...args: any[]) => unknown>()
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
})
