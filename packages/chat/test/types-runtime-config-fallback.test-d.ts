import { describe, expectTypeOf, it } from "vitest"

import "../src/nitro.ts"
import { defineChat } from "@vitehub/chat"

describe("Nitro runtime config fallback types", () => {
  it("keeps authored chats usable without generated Nitro env declarations", () => {
    defineChat({
      adapters({ runtimeConfig }) {
        expectTypeOf(runtimeConfig.untypedService).toBeAny()
        expectTypeOf(runtimeConfig.untypedService.apiKey).toBeAny()
        return {}
      },
      state: {} as never,
    })
  })
})
