import { describe, expect, it } from "vitest"

describe("@vitehub/chat/cloudflare", () => {
  it("loads in Node without importing Cloudflare Worker-only modules", async () => {
    const mod = await import("../src/cloudflare.ts")

    expect(mod.cloudflareDurableObjectState).toBeTypeOf("function")
    expect(mod.defineCloudflareChatHandler).toBeTypeOf("function")
  })
})
