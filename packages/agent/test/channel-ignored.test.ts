import { describe, expect, it, vi } from "vitest"

import { defineChannel, defineChannelTrigger, ignored } from "@vite-hub/agent/channels"
import { defineAgent, runAgentTrigger } from "../src/index.ts"
import { createAgentRuntimeContext } from "../src/runtime/context.ts"

describe("ignored()", () => {
  it("answers HTTP 200 with the reason and accepted: false", async () => {
    const response = ignored("not_mine")
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ accepted: false, ok: true, reason: "not_mine" })
  })

  it("stops a Channel trigger without starting an Invocation", async () => {
    const run = vi.fn(() => "ok")
    const agent = defineAgent({
      channels: {
        tickets: defineChannel("tickets", {
          messages: false,
          triggers: {
            opened: defineChannelTrigger({
              invoke: (_context, event: { bot: boolean }) => event.bot ? ignored("bot_ticket") : { input: { prompt: "triage" } },
            }),
          },
        }),
      },
      driver: { run },
    })
    const runtime = { ...createAgentRuntimeContext({ runtime: "unknown", waitUntil: vi.fn() }), capabilities: {} }

    const response = await runAgentTrigger(agent, runtime, "tickets.opened", { bot: true })
    expect(response).toBeInstanceOf(Response)
    await expect((response as Response).json()).resolves.toEqual({ accepted: false, ok: true, reason: "bot_ticket" })
    expect(run).not.toHaveBeenCalled()
    await expect(runAgentTrigger(agent, runtime, "tickets.opened", { bot: false })).resolves.toBe("ok")
  })
})
