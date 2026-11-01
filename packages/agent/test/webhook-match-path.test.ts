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

describe("webhook handler matchesPath()", () => {
  it("matches declared paths and aliases and reads the Agent once for every request", async () => {
    const { handler, reads } = hookAgent()
    const matches = (path: string) => handler.matchesPath(new Request(`http://app.test${path}`))

    await expect(matches("/hook")).resolves.toBe(true)
    await expect(matches("/hook/?x=1")).resolves.toBe(true)
    await expect(matches("/old-hook")).resolves.toBe(true)
    await expect(matches("/hello")).resolves.toBe(false)
    await expect(matches("/hook/more")).resolves.toBe(false)
    expect(reads.count).toBe(1)
  })

  it("resolves the paths again after a failed resolution", async () => {
    const { handler, reads } = hookAgent()
    reads.fail = true
    await expect(handler.matchesPath(new Request("http://app.test/hook"))).rejects.toThrow("channels are not ready")
    reads.fail = false
    await expect(handler.matchesPath(new Request("http://app.test/hook"))).resolves.toBe(true)
  })
})
