import { describe, expect, it, vi } from "vitest"

import { createChatMessageTriggerInput } from "../src/chat-message-input.ts"
import { defineAgent, portableAgentWorkflowInput, runAgentInline } from "../src/index.ts"
import { resolveAgentChannelChatOptions } from "../src/internal/channels.ts"
import { hasRuntimeType, isRuntimeRecord } from "../src/internal/runtime-type.ts"
import { createAgentInvocationContextStore } from "../src/invocation-context.ts"
import { hasResolvedAgentInvokerInput, withResolvedAgentInvokerInput } from "../src/invoker.ts"
import {
  hasParsedAgentMessageMeta,
  parsedAgentMessageMetaReceiptId,
  parseAgentMessageMeta,
  restoreParsedAgentMessageMeta,
  withParsedAgentMessageMeta,
} from "../src/internal/message-meta.ts"

vi.mock("#vitehub/agent/registry", () => ({ default: {} }))

const metaSchema = {
  "~standard": {
    validate(input: unknown) {
      const meta = isRuntimeRecord(input) && !Array.isArray(input) ? input : undefined
      if (!meta || ![undefined, "support", "technical"].includes(hasRuntimeType(meta.audience, "string") ? meta.audience : undefined)) {
        return { issues: [{ message: "audience must be support or technical" }] }
      }
      return { value: { audience: meta.audience ?? "support" } }
    },
    vendor: "vitehub-test",
    version: 1,
  },
} as const

const metaSettings = { meta: metaSchema, metaRevision: "test-v1" } as const

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
      support: { kind: "support", messages: metaSettings },
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
      messages: metaSettings,
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
      channels: { support: { kind: "support", messages: { meta: channelSchema, metaRevision: "channel-v1" } } },
      driver: { run: ({ context }) => {
        observed = context.get("channel")
        return "ok"
      } },
      messages: metaSettings,
    })

    await runAgentInline(agent, runtime({ channelId: "support", runId: "run-support" }), {
      context: { channel: { meta: { audience: "technical" } } },
    })

    expect(observed).toEqual({ meta: { source: "channel" } })
  })

  it("rejects invalid metadata before the driver runs", async () => {
    const run = vi.fn(() => "unreachable")
    const agent = defineAgent({ driver: { run }, messages: metaSettings })

    await expect(runAgentInline(agent, runtime(), {
      context: { channel: { meta: { audience: "customer" } } },
    })).rejects.toThrow("Invalid agent channel metadata")
    expect(run).not.toHaveBeenCalled()
  })

  it("passes explicit null metadata to the schema", async () => {
    const validate = vi.fn(() => ({ issues: [{ message: "metadata must be an object" }] }))
    const agent = defineAgent({
      driver: { run: () => "unreachable" },
      // SAFETY: this deliberately incomplete schema tests runtime validation of untyped definitions.
      messages: { meta: { "~standard": { validate } } as never },
    })

    await expect(runAgentInline(agent, runtime(), {
      // SAFETY: explicit null is outside the typed contract and is the boundary case under test.
      context: { channel: { meta: null } } as never,
    })).rejects.toThrow("Invalid agent channel metadata")
    expect(validate).toHaveBeenCalledWith(null)
  })

  it("rejects schemas that transform metadata to a non-object", async () => {
    const agent = defineAgent({
      driver: { run: () => "unreachable" },
      // SAFETY: this deliberately invalid output schema tests the runtime object-output guard.
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
    const agent = defineAgent({ driver: { run: () => "ok" }, messages: { meta: schema, metaRevision: "parse-v1" } })
    const prepared = await withParsedAgentMessageMeta(agent, { context: { channel: { meta: {} } } })

    await parseAgentMessageMeta(agent, createAgentInvocationContextStore(prepared.context))

    expect(parses).toBe(1)
    expect(prepared.context?.channel).toEqual({ meta: { parse: 1 } })
  })

  it("preserves resolved Invoker custody while parsing metadata", async () => {
    const resolve = vi.fn(() => ({ id: "chat:replacement", kind: "chat" }))
    const agent = defineAgent({
      driver: { run: () => "ok" },
      invoker: { resolve },
      messages: metaSettings,
    })
    const prepared = await withParsedAgentMessageMeta(agent, withResolvedAgentInvokerInput({
      context: { channel: { meta: { audience: "technical" } } },
    }, { id: "chat:user-1", kind: "chat", meta: { audience: "technical" } }))

    expect(hasResolvedAgentInvokerInput(prepared)).toBe(true)
    await runAgentInline(agent, runtime(), prepared)
    expect(resolve).not.toHaveBeenCalled()
  })

  it("does not reuse another Agent Definition's metadata receipt", async () => {
    const first = defineAgent({ driver: { run: () => "ok" }, messages: metaSettings })
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
    const agent = defineAgent({ driver: { run: () => "ok" }, messages: { meta: schema, metaRevision: "durable-v1" } })
    const prepared = await withParsedAgentMessageMeta(agent, { context: { channel: { meta: {} } } })

    expect(hasParsedAgentMessageMeta(agent, prepared)).toBe(true)
    const receiptId = parsedAgentMessageMetaReceiptId(agent, prepared)
    const portable = await portableAgentWorkflowInput(prepared)
    const workflowAgent = defineAgent({ driver: { run: () => "ok" }, messages: { meta: schema, metaRevision: "durable-v1" } })
    const restored = restoreParsedAgentMessageMeta(workflowAgent, portable, undefined, receiptId)
    await parseAgentMessageMeta(workflowAgent, createAgentInvocationContextStore(restored.context))

    expect(parses).toBe(1)
    expect(restored.context?.channel).toEqual({ meta: { parse: 1 } })
  })

  it("restores trusted parsed metadata with an empty revision", async () => {
    let parses = 0
    const schema = {
      "~standard": {
        validate: () => ({ value: { parse: ++parses } }),
        vendor: "vitehub-test",
        version: 1,
      },
    } as const
    const agent = defineAgent({ driver: { run: () => "ok" }, messages: { meta: schema, metaRevision: "" } })
    const prepared = await withParsedAgentMessageMeta(agent, { context: { channel: { meta: {} } } })
    const receiptId = parsedAgentMessageMetaReceiptId(agent, prepared)
    const portable = await portableAgentWorkflowInput(prepared)
    const restored = restoreParsedAgentMessageMeta(agent, portable, undefined, receiptId)

    await parseAgentMessageMeta(agent, createAgentInvocationContextStore(restored.context))

    expect(receiptId).toBe("")
    expect(parses).toBe(1)
  })

  it("revalidates durable metadata when the schema receipt is no longer current", async () => {
    const previousAgent = defineAgent({ driver: { run: () => "ok" }, messages: metaSettings })
    const prepared = await withParsedAgentMessageMeta(previousAgent, { context: { channel: { meta: { audience: "technical" } } } })
    const previousReceiptId = parsedAgentMessageMetaReceiptId(previousAgent, prepared)
    const portable = await portableAgentWorkflowInput(prepared)
    const currentAgent = defineAgent({
      driver: { run: () => "ok" },
      messages: {
        meta: {
          "~standard": {
            validate: () => ({ value: { audience: "current" } }),
            vendor: "vitehub-test",
            version: 1,
          },
        },
        metaRevision: "current-v2",
      },
    })
    const restored = restoreParsedAgentMessageMeta(currentAgent, portable, undefined, previousReceiptId)
    const context = createAgentInvocationContextStore(restored.context)

    await parseAgentMessageMeta(currentAgent, context)

    expect(context.get("channel")).toEqual({ meta: { audience: "current" } })
  })

  it("transforms nonportable metadata before a durable handoff", async () => {
    const agent = defineAgent({
      driver: { run: () => "ok" },
      messages: {
        meta: {
          "~standard": {
            // SAFETY: this schema's contract requires a Date and the test supplies one before portability.
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
    const agent = defineAgent({ driver: { run: () => "ok" }, messages: metaSettings })
    const input = createChatMessageTriggerInput({}, {
      messages: [{ parts: [{ text: "hello", type: "text" }], role: "user" }],
      meta: { audience: "technical", ignored: true },
      user: { email: "user@example.com", id: "chat:user-1" },
    }).input
    const context = createAgentInvocationContextStore(input.context)

    await parseAgentMessageMeta(agent, context)

    expect(context.get("invoker")).toEqual({
      email: {
        address: "user@example.com",
        domain: "example.com",
      },
      id: "chat:user-1",
      kind: "chat",
      meta: { audience: "technical", email: "user@example.com", id: "chat:user-1" },
    })
    expect(context.get("actor")).toEqual(context.get("invoker"))
  })

  it("preserves metadata owned by an explicit chat Invoker", async () => {
    const agent = defineAgent({ driver: { run: () => "ok" }, messages: metaSettings })
    const input = createChatMessageTriggerInput({}, {
      invoker: { id: "trusted", kind: "chat", meta: { audience: "internal", ignored: "trusted" } },
      messages: [{ parts: [{ text: "hello", type: "text" }], role: "user" }],
      meta: { audience: "technical", ignored: "untrusted" },
    }).input
    const context = createAgentInvocationContextStore(input.context)

    await parseAgentMessageMeta(agent, context)

    expect(context.get("invoker")).toEqual({
      id: "trusted",
      kind: "chat",
      meta: { audience: "internal", ignored: "trusted" },
    })
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
    const input = createChatMessageTriggerInput({}, {
      messages: [{ parts: [{ text: "hello", type: "text" }], role: "user" }],
      user: { id: "chat:user-1" },
    }).input
    const context = createAgentInvocationContextStore({ ...input.context, channel: { meta: null } })

    await parseAgentMessageMeta(agent, context)

    expect(context.get("invoker")).toEqual({ id: "chat:user-1", kind: "chat", meta: { audience: "support", id: "chat:user-1" } })
    expect(context.get("actor")).toEqual(context.get("invoker"))
  })

  it("removes derived Invoker identity stripped by the metadata schema", async () => {
    const agent = defineAgent({ driver: { run: () => "ok" }, messages: metaSettings })
    const input = createChatMessageTriggerInput({}, {
      messages: [{ parts: [{ text: "hello", type: "text" }], role: "user" }],
      meta: { audience: "technical", email: "raw@example.com" },
      user: { id: "chat:user-1" },
    }).input
    const context = createAgentInvocationContextStore(input.context)

    await parseAgentMessageMeta(agent, context)

    expect(context.get("invoker")).toEqual({
      id: "chat:user-1",
      kind: "chat",
      meta: { audience: "technical", id: "chat:user-1" },
    })
    expect(context.get("actor")).toEqual(context.get("invoker"))
  })

  it("retains user identity metadata when the schema strips the matching raw field", async () => {
    const agent = defineAgent({ driver: { run: () => "ok" }, messages: metaSettings })
    const input = createChatMessageTriggerInput({}, {
      messages: [{ parts: [{ text: "hello", type: "text" }], role: "user" }],
      meta: { audience: "technical", email: "user@example.com" },
      user: { email: "user@example.com" },
    }).input
    const context = createAgentInvocationContextStore(input.context)

    await parseAgentMessageMeta(agent, context)

    expect(context.get("invoker")).toEqual({
      email: { address: "user@example.com", domain: "example.com" },
      id: "user@example.com",
      kind: "chat",
      meta: { audience: "technical", email: "user@example.com" },
    })
    expect(context.get("actor")).toEqual(context.get("invoker"))
  })

  it("preserves explicit programmatic Invokers while parsing Channel metadata", async () => {
    const resolve = vi.fn(({ defaultInvoker, input }) => {
      expect(input.context?.invoker).toEqual({
        id: "chat:user-1",
        kind: "chat",
        meta: { audience: "technical", email: "user@example.com", ignored: true },
      })
      return defaultInvoker
    })
    const run = vi.fn(({ invoker }) => {
      expect(invoker).toEqual({
        id: "chat:user-1",
        kind: "chat",
        meta: { audience: "technical", email: "user@example.com", ignored: true },
      })
      return "ok"
    })
    const agent = defineAgent({
      capabilities: ({ input }) => {
        expect(input.context?.channel).toEqual({ meta: { audience: "technical" } })
        expect(input.context?.invoker).toEqual({
          id: "chat:user-1",
          kind: "chat",
          meta: { audience: "technical", email: "user@example.com", ignored: true },
        })
        return []
      },
      driver: { run },
      invoker: { resolve },
      messages: metaSettings,
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
