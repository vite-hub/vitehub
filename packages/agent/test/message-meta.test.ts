import { describe, expect, it, vi } from "vitest"

import { defineAgent, portableAgentWorkflowInput, runAgentInline } from "../src/index.ts"
import { resolveAgentChannelChatOptions } from "../src/internal/channels.ts"
import { createAgentInvocationContextStore } from "../src/invocation-context.ts"
import {
  hasParsedAgentMessageMeta,
  parseAgentMessageMeta,
  restoreParsedAgentMessageMeta,
  withParsedAgentMessageMeta,
} from "../src/internal/message-meta.ts"

vi.mock("#vitehub/agent/registry", () => ({ default: {} }))

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

  it("passes explicit null metadata to the schema", async () => {
    const validate = vi.fn(() => ({ issues: [{ message: "metadata must be an object" }] }))
    const agent = defineAgent({
      driver: { run: () => "unreachable" },
      messages: { meta: { "~standard": { validate } } as never },
    })

    await expect(runAgentInline(agent, runtime(), {
      context: { channel: { meta: null } } as never,
    })).rejects.toThrow("Invalid agent channel metadata")
    expect(validate).toHaveBeenCalledWith(null)
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

  it("reuses metadata parsed before authorization during invocation", async () => {
    let parses = 0
    const schema = {
      "~standard": {
        validate: () => ({ value: { parse: ++parses } }),
        vendor: "vitehub-test",
        version: 1,
      },
    } as const
    const agent = defineAgent({ driver: { run: () => "ok" }, messages: { meta: schema } })
    const prepared = await withParsedAgentMessageMeta(agent, { context: { channel: { meta: {} } } })

    await parseAgentMessageMeta(agent, createAgentInvocationContextStore(prepared.context))

    expect(parses).toBe(1)
    expect(prepared.context?.channel).toEqual({ meta: { parse: 1 } })
  })

  it("does not reuse another Agent Definition's metadata receipt", async () => {
    const first = defineAgent({ driver: { run: () => "ok" }, messages: { meta: metaSchema } })
    const secondSchema = {
      "~standard": {
        validate: () => ({ value: { owner: "second" } }),
        vendor: "vitehub-test",
        version: 1,
      },
    } as const
    const second = defineAgent({ driver: { run: () => "ok" }, messages: { meta: secondSchema } })
    const prepared = await withParsedAgentMessageMeta(first, { context: { channel: { meta: {} } } })
    const context = createAgentInvocationContextStore(prepared.context)

    await parseAgentMessageMeta(second, context)

    expect(context.get("channel")).toEqual({ meta: { owner: "second" } })
  })

  it("restores trusted parsed metadata after a durable handoff", async () => {
    let parses = 0
    const schema = {
      "~standard": {
        validate: () => ({ value: { parse: ++parses } }),
        vendor: "vitehub-test",
        version: 1,
      },
    } as const
    const agent = defineAgent({ driver: { run: () => "ok" }, messages: { meta: schema } })
    const prepared = await withParsedAgentMessageMeta(agent, { context: { channel: { meta: {} } } })

    expect(hasParsedAgentMessageMeta(agent, prepared)).toBe(true)
    const portable = await portableAgentWorkflowInput(prepared)
    const restored = restoreParsedAgentMessageMeta(agent, portable)
    await parseAgentMessageMeta(agent, createAgentInvocationContextStore(restored.context))

    expect(parses).toBe(1)
    expect(restored.context?.channel).toEqual({ meta: { parse: 1 } })
  })

  it("transforms nonportable metadata before a durable handoff", async () => {
    const agent = defineAgent({
      driver: { run: () => "ok" },
      messages: {
        meta: {
          "~standard": {
            validate: (input: unknown) => ({ value: { sentAt: (input as { sentAt: Date }).sentAt.toISOString() } }),
            vendor: "vitehub-test",
            version: 1,
          },
        },
      },
    })
    const input = { context: { channel: { meta: { sentAt: new Date("2026-08-27T09:00:00.000Z") } } } }

    await expect(portableAgentWorkflowInput(input)).rejects.toThrow()
    const portable = await portableAgentWorkflowInput(await withParsedAgentMessageMeta(agent, input))

    expect(portable.context?.channel).toEqual({ meta: { sentAt: "2026-08-27T09:00:00.000Z" } })
  })

  it("does not trust a caller-provided parsed marker", async () => {
    let parses = 0
    const schema = {
      "~standard": {
        validate: () => ({ value: { parse: ++parses } }),
        vendor: "vitehub-test",
        version: 1,
      },
    } as const
    const agent = defineAgent({ driver: { run: () => "ok" }, messages: { meta: schema } })

    await parseAgentMessageMeta(agent, createAgentInvocationContextStore({
      channel: { meta: {} },
      "vitehub.agent.messageMetaParsed": true,
    }))

    expect(parses).toBe(1)
  })

  it("rebuilds a chat invoker from parsed metadata", async () => {
    const agent = defineAgent({ driver: { run: () => "ok" }, messages: { meta: metaSchema } })
    const context = createAgentInvocationContextStore({
      actor: { id: "chat:user-1", kind: "chat", meta: { audience: "technical", email: "user@example.com", ignored: true } },
      channel: { meta: { audience: "technical", ignored: true } },
      invoker: { id: "chat:user-1", kind: "chat", meta: { audience: "technical", email: "user@example.com", ignored: true } },
    })

    await parseAgentMessageMeta(agent, context)

    expect(context.get("invoker")).toEqual({
      email: {
        address: "user@example.com",
        domain: "example.com",
      },
      id: "chat:user-1",
      kind: "chat",
      meta: { audience: "technical", email: "user@example.com" },
    })
    expect(context.get("actor")).toEqual(context.get("invoker"))
  })

  it("rebuilds a chat invoker when null metadata is normalized", async () => {
    const schema = {
      "~standard": {
        validate: () => ({ value: { audience: "support" } }),
        vendor: "vitehub-test",
        version: 1,
      },
    } as const
    const agent = defineAgent({ driver: { run: () => "ok" }, messages: { meta: schema } })
    const context = createAgentInvocationContextStore({
      actor: { id: "chat:user-1", kind: "chat", meta: {} },
      channel: { meta: null },
      invoker: { id: "chat:user-1", kind: "chat", meta: {} },
    })

    await parseAgentMessageMeta(agent, context)

    expect(context.get("invoker")).toEqual({ id: "chat:user-1", kind: "chat", meta: { audience: "support" } })
    expect(context.get("actor")).toEqual(context.get("invoker"))
  })

  it("removes derived Invoker identity stripped by the metadata schema", async () => {
    const agent = defineAgent({ driver: { run: () => "ok" }, messages: { meta: metaSchema } })
    const context = createAgentInvocationContextStore({
      actor: {
        email: { address: "raw@example.com", domain: "example.com" },
        id: "chat:user-1",
        kind: "chat",
        meta: { audience: "technical", email: "raw@example.com" },
      },
      channel: { meta: { audience: "technical", email: "raw@example.com" } },
      invoker: {
        email: { address: "raw@example.com", domain: "example.com" },
        id: "chat:user-1",
        kind: "chat",
        meta: { audience: "technical", email: "raw@example.com" },
      },
    })

    await parseAgentMessageMeta(agent, context)

    expect(context.get("invoker")).toEqual({
      id: "chat:user-1",
      kind: "chat",
      meta: { audience: "technical" },
    })
    expect(context.get("actor")).toEqual(context.get("invoker"))
  })

  it("resolves programmatic Invokers from parsed metadata", async () => {
    const resolve = vi.fn(({ defaultInvoker, input }) => {
      expect(input.context?.invoker).toEqual({
        email: {
          address: "user@example.com",
          domain: "example.com",
        },
        id: "chat:user-1",
        kind: "chat",
        meta: { audience: "technical", email: "user@example.com" },
      })
      return defaultInvoker
    })
    const run = vi.fn(({ invoker }) => {
      expect(invoker).toEqual({
        email: {
          address: "user@example.com",
          domain: "example.com",
        },
        id: "chat:user-1",
        kind: "chat",
        meta: { audience: "technical", email: "user@example.com" },
      })
      return "ok"
    })
    const agent = defineAgent({
      capabilities: ({ input }) => {
        expect(input.context?.channel).toEqual({ meta: { audience: "technical" } })
        expect(input.context?.invoker).toEqual({
          email: {
            address: "user@example.com",
            domain: "example.com",
          },
          id: "chat:user-1",
          kind: "chat",
          meta: { audience: "technical", email: "user@example.com" },
        })
        return []
      },
      driver: { run },
      invoker: { resolve },
      messages: { meta: metaSchema },
    })

    await runAgentInline(agent, runtime(), {
      context: {
        channel: { meta: { audience: "technical", ignored: true } },
        invoker: {
          id: "chat:user-1",
          kind: "chat",
          meta: { audience: "technical", email: "user@example.com", ignored: true },
        },
      },
    })

    expect(resolve).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledOnce()
  })
})
