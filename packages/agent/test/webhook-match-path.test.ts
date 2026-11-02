import { describe, expect, it } from "vitest"

import { defineChannel, defineChannelTrigger, ignored } from "../src/channels.ts"
import { defineAgent } from "../src/index.ts"
import { createChannelWebhookRouteHandler } from "../src/server/internal.ts"

function hookAgent() {
  const agent = defineAgent({ driver: { run: () => "unused" } })
  const channels = {
    hook: defineChannel("hook", {
      messages: false,
      triggers: { webhook: defineChannelTrigger({ invoke: () => ignored("unused") }) },
      webhooks: { aliases: ["/old-hook/"], path: "hook/", provider: "hook" },
    }),
  }
  const reads = { count: 0, fail: false }
  Object.defineProperty(agent, "channels", {
    get() {
      reads.count++
      if (reads.fail) throw new Error("channels are not ready")
      return channels
    },
  })
  // SAFETY: The test Agent satisfies the route handler contract.
  return { handler: createChannelWebhookRouteHandler(agent as never), reads }
}

describe("webhook handler declaredPathMatcher()", () => {
  it("matches declared paths and aliases and reads the Agent once for every matcher", async () => {
    const { handler, reads } = hookAgent()
    const matches = await handler.declaredPathMatcher(new Request("http://app.test/hello"))

    expect(matches("/hook")).toBe(true)
    expect(matches("/hook/")).toBe(true)
    expect(matches("/old-hook")).toBe(true)
    expect(matches("/hello")).toBe(false)
    expect(matches("/hook/more")).toBe(false)
    expect((await handler.declaredPathMatcher(new Request("http://app.test/other")))("/hook")).toBe(true)
    expect(reads.count).toBe(1)
  })

  it("resolves the paths again after a failed resolution", async () => {
    const { handler, reads } = hookAgent()
    reads.fail = true
    await expect(handler.declaredPathMatcher(new Request("http://app.test/hook"))).rejects.toThrow("channels are not ready")
    reads.fail = false
    expect((await handler.declaredPathMatcher(new Request("http://app.test/hook")))("/hook")).toBe(true)
  })
})
