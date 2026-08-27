import { describe, expect, it, vi } from "vitest"

import { defineAgent, runAgentInline } from "../src/index.ts"
import { resolveAgentChannelChatOptions } from "../src/internal/channels.ts"

const metaSchema = {
  "~standard": {
    validate(input: unknown) {
      const meta = input as Record<string, unknown>
      if (!meta || typeof meta !== "object" || Array.isArray(meta) || ![undefined, "support", "technical"].includes(meta.audience as string | undefined)) {
        return { issues: [{ message: "audience must be support or technical" }] }
      }
      return { value: { audience: meta.audience ?? "support" } }
    },
    vendor: "vitehub-test",
    version: 1,
  },
} as const

function runtime(run?: { channelId?: string, runId: string }) {
  return {
    memo: vi.fn(),
    run,
    runtime: "unknown" as const,
    waitUntil: vi.fn(),
  }
}

describe("Agent message metadata", () => {
  it("allows Channel-local metadata schemas with multiple message Channels", () => {
    expect(() => resolveAgentChannelChatOptions({
      support: { kind: "support", messages: { meta: metaSchema } },
      technical: { kind: "technical", messages: {} },
    }, undefined)).not.toThrow()
  })

  it("validates and transforms shared channel and chat metadata before the driver runs", async () => {
    let observed: unknown
    const agent = defineAgent({
      driver: { run: ({ context }) => {
        observed = { channel: context.get("channel"), chat: context.get("chat") }
        return "ok"
      } },
      messages: { meta: metaSchema },
    })

    await runAgentInline(agent, runtime(), {
      context: {
        channel: { meta: { audience: "technical", ignored: true } },
        chat: { meta: { audience: "technical", ignored: true } },
      },
    })

    expect(observed).toEqual({
      channel: { meta: { audience: "technical" } },
      chat: { meta: { audience: "technical" } },
    })
  })

  it("uses the active Channel metadata schema over shared settings", async () => {
    let observed: unknown
    const channelSchema = {
      "~standard": {
        validate: () => ({ value: { source: "channel" } }),
        vendor: "vitehub-test",
        version: 1,
      },
    } as const
    const agent = defineAgent({
      channels: { support: { kind: "support", messages: { meta: channelSchema } } },
      driver: { run: ({ context }) => {
        observed = context.get("channel")
        return "ok"
      } },
      messages: { meta: metaSchema },
    })

    await runAgentInline(agent, runtime({ channelId: "support", runId: "run-support" }), {
      context: { channel: { meta: { audience: "technical" } } },
    })

    expect(observed).toEqual({ meta: { source: "channel" } })
  })

  it("rejects invalid metadata before the driver runs", async () => {
    const run = vi.fn(() => "unreachable")
    const agent = defineAgent({ driver: { run }, messages: { meta: metaSchema } })

    await expect(runAgentInline(agent, runtime(), {
      context: { channel: { meta: { audience: "customer" } } },
    })).rejects.toThrow("Invalid agent channel metadata")
    expect(run).not.toHaveBeenCalled()
  })

  it("rejects schemas that transform metadata to a non-object", async () => {
    const agent = defineAgent({
      driver: { run: () => "unreachable" },
      messages: { meta: { "~standard": { validate: () => ({ value: "invalid" }) } } as never },
    })

    await expect(runAgentInline(agent, runtime(), {
      context: { channel: { meta: {} } },
    })).rejects.toThrow("metadata schema must return an object")
  })
})
