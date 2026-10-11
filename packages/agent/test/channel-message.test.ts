import { describe, expect, it, vi } from "vitest"
import * as v from "valibot"

import { createTraceEventLog } from "@vite-hub/runtime"
import { defineChannel } from "../src/channels.ts"
import { defineAgent, runAgent, runAgentTrigger } from "../src/index.ts"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "../src/server.ts"
import type { AgentChannelMessage } from "../src/index.ts"
import type { AgentRuntimeContext } from "../src/types.ts"

function runtimeContext(traceLog = createTraceEventLog()): AgentRuntimeContext {
  // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
  return { memo: vi.fn(), runtime: "unknown" as const, traceLog, waitUntil: vi.fn() } as AgentRuntimeContext
}

/** Records Invocations like the Console: metadata only, plus Channel delivery content. */
function consoleInvocations() {
  return defineAgentInvocations({ metadataContent: ["channel.effect.content"], store: createMemoryAgentInvocationStore() })
}

async function deliveryObservations(invocations: ReturnType<typeof consoleInvocations>, runId: string) {
  let observations: { attributes?: Record<string, unknown> }[] = []
  await vi.waitFor(async () => {
    const record = await invocations.getByRunId(runId)
    expect(record?.status).toBe("completed")
    observations = (record?.observations || []).filter(observation => observation.name === "agent.channel.delivery.effect")
  })
  return observations
}

function mailChannel(provider: { label: (id: string, add: string[]) => void, subject: (id: string) => string }, options: { dryRun?: boolean } = {}) {
  return defineChannel("mail", {
    message: {
      data: v.object({ id: v.string() }),
      methods: {
        label(context, input: { add: string[] }) {
          provider.label(context.message.id, input.add)
          return { applied: input.add.length }
        },
        subject: {
          read: true,
          handler: context => provider.subject(context.message.id),
        },
      },
    },
    messages: false,
    triggers: {
      message: {
        invoke: (context, input: { id: string }) => ({
          input: { prompt: `mail ${input.id}`, ...(options.dryRun ? { dryRun: true } : {}) },
          message: { id: input.id },
          run: { channelId: context.trigger.channelId, origin: context.channel.kind, runId: `mail-${input.id}` },
        }),
      },
    },
  })
}

describe("Channel message handle", () => {
  it("gives finish hooks typed Channel message methods", async () => {
    const provider = { label: vi.fn(), subject: vi.fn(() => "Invoice") }
    const seen: unknown[] = []
    const agent = defineAgent({
      channels: { mail: mailChannel(provider) },
      driver: { run: () => "Receipts" },
      hooks: {
        async "agent:finish"(event) {
          if (!event.message) throw new Error("expected a Channel message")
          seen.push(event.message.channel, event.message.kind, event.message.data)
          seen.push(await event.message.subject())
          seen.push(await event.message.label({ add: [String(event.text)] }))
        },
      },
    })

    await expect(runAgentTrigger(agent, runtimeContext(), "mail.message", { id: "m1" })).resolves.toBe("Receipts")
    expect(seen).toEqual(["mail", "mail", { id: "m1" }, "Invoice", { applied: 1 }])
    expect(provider.label).toHaveBeenCalledWith("m1", ["Receipts"])
  })

  it("records write methods in a dry run and still runs read methods", async () => {
    const provider = { label: vi.fn(), subject: vi.fn(() => "Invoice") }
    const invocations = consoleInvocations()
    let subject: unknown
    const agent = defineAgent({
      channels: { mail: mailChannel(provider, { dryRun: true }) },
      driver: { run: () => "Receipts" },
      invocations,
      hooks: {
        async "agent:finish"(event) {
          subject = await event.message?.subject()
          await expect(event.message?.label({ add: ["Receipts"] })).resolves.toBeUndefined()
        },
      },
    })

    await runAgentTrigger(agent, runtimeContext(), "mail.message", { id: "m2" })
    expect(subject).toBe("Invoice")
    expect(provider.subject).toHaveBeenCalledWith("m2")
    expect(provider.label).not.toHaveBeenCalled()
    expect(await deliveryObservations(invocations, "mail-m2")).toMatchObject([
      { attributes: { "channel.effect.kind": "subject", "channel.effect.read": true } },
      {
        attributes: {
          "channel.effect.content": "label({\"add\":[\"Receipts\"]})",
          "channel.effect.kind": "label",
          "channel.effect.skipped": "dry-run",
          "channel.effect.read": false,
        },
      },
    ])
  })

  it("routes event.reply() to a Channel reply method and skips it in a dry run", async () => {
    const reply = vi.fn()
    const invocations = consoleInvocations()
    const channel = (dryRun: boolean) => defineChannel("portal", {
      message: { methods: { reply: (_context, input: unknown) => { reply(input) } } },
      messages: false,
      triggers: {
        message: {
          invoke: context => ({
            input: { dryRun, prompt: "hello" },
            run: { channelId: context.trigger.channelId, origin: context.channel.kind, runId: `portal-${dryRun}` },
          }),
        },
      },
    })
    const agent = (dryRun: boolean) => defineAgent({
      channels: { portal: channel(dryRun) },
      driver: { run: () => "ok" },
      hooks: {
        "agent:finish": event => event.reply(`done:${event.text}`),
      },
      invocations,
    })

    await runAgentTrigger(agent(false), runtimeContext(), "portal.message", {})
    expect(reply).toHaveBeenCalledWith("done:ok")
    reply.mockClear()
    await runAgentTrigger(agent(true), runtimeContext(), "portal.message", {})
    expect(reply).not.toHaveBeenCalled()
    expect(await deliveryObservations(invocations, "portal-true")).toMatchObject([{
      attributes: { "channel.effect.content": "done:ok", "channel.effect.kind": "reply", "channel.effect.skipped": "dry-run" },
    }])
  })

  it("keeps the built-in reply of Chat SDK Channels on event.message", async () => {
    const postMessage = vi.fn()
    const agent = defineAgent({
      channels: {
        portal: defineChannel("portal", {
          // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
          adapter: { channelIdFromThreadId: () => "channel-1", postMessage } as never,
          messages: { delivery: "manual" },
          triggers: {
            message: {
              invoke: context => ({
                input: { prompt: "hello" },
                run: { channelId: context.trigger.channelId, origin: context.channel.kind, runId: "portal-run", threadId: "thread-1" },
              }),
            },
          },
        }),
      },
      driver: { run: () => "ok" },
      hooks: {
        async "agent:finish"(event) {
          // SAFETY: A custom Chat SDK Channel kind has no static reply type; the runtime handle provides it.
          await (event.message as AgentChannelMessage<"portal", "portal", unknown, { reply: (input: string) => Promise<void> }>).reply("from hook")
        },
      },
    })

    await runAgentTrigger(agent, runtimeContext(), "portal.message", {})
    expect(postMessage).toHaveBeenCalledOnce()
    expect(postMessage.mock.calls[0]?.[0]).toBe("thread-1")
    expect(JSON.stringify(postMessage.mock.calls[0]?.[1])).toContain("from hook")
  })

  it.each(["native stream", "buffered stream", "unsupported stream", "artifacts"] as const)("preserves the reply thread for %s", async (mode) => {
    const postMessage = vi.fn()
    const channelIdFromThreadId = () => "channel-1"
    const stream = vi.fn(async (_threadId: string, chunks: AsyncIterable<string>) => {
      if (mode === "buffered stream") return null
      let markdown = ""
      for await (const chunk of chunks) markdown += chunk
      return { id: "sent", raw: { markdown } }
    })
    const agent = defineAgent({
      channels: {
        support: defineChannel("teams", {
          // SAFETY: The fixture implements the Chat SDK methods exercised by reply delivery.
          adapter: { channelIdFromThreadId, postMessage, ...(mode === "unsupported stream" ? {} : { stream }) } as never,
          messages: { delivery: "manual" },
          triggers: {
            message: {
              invoke: context => ({
                input: { prompt: "hello" },
                run: { channelId: context.trigger.channelId, origin: "teams", runId: `reply-${mode}`, threadId: "thread-1" },
              }),
            },
          },
        }),
      },
      driver: { run: () => "ok" },
      hooks: {
        "agent:finish"(event) {
          return mode === "artifacts"
            ? event.reply({ body: "from hook", artifacts: [{ path: "report.md", placement: "link", url: "https://assets.example/report.md" }] })
            : event.reply((async function* () { yield "from "; yield "hook" })())
        },
      },
    })

    await runAgentTrigger(agent, runtimeContext(), "support.message", {})
    if (mode === "native stream") {
      expect(stream).toHaveBeenCalledExactlyOnceWith("thread-1", expect.anything())
      expect(postMessage).not.toHaveBeenCalled()
    }
    else {
      expect(postMessage).toHaveBeenCalledExactlyOnceWith("thread-1", {
        markdown: mode === "artifacts" ? "from hook\n\n[report.md](<https://assets.example/report.md>)" : "from hook",
      })
      if (mode === "buffered stream") expect(stream).toHaveBeenCalledExactlyOnceWith("thread-1", expect.anything())
      else expect(stream).not.toHaveBeenCalled()
    }
  })

  it.each([false, true])("labels unresolved citations in Chat SDK delivery, streaming=%s", async (streaming) => {
    const delivered: string[] = []
    const text = "Verified answer. citeturn228505view0turn395856view0 See [PR #1188](https://github.com/acme/portal/pull/1188)."
    const adapter = {
      channelIdFromThreadId: (threadId: string) => threadId,
      postMessage: vi.fn(async (_threadId: string, message: { markdown: string }) => { delivered.push(message.markdown) }),
      stream: vi.fn(async (_threadId: string, chunks: AsyncIterable<string>) => {
        let markdown = ""
        for await (const chunk of chunks) markdown += chunk
        delivered.push(markdown)
        return { id: "sent" }
      }),
    }
    const agent = defineAgent({
      channels: {
        support: defineChannel("teams", {
          // SAFETY: The fixture implements the Chat SDK methods exercised by reply delivery.
          adapter: adapter as never,
          messages: { delivery: "manual" },
          triggers: {
            message: {
              invoke: context => ({
                input: { prompt: "hello" },
                run: { channelId: context.trigger.channelId, origin: "teams", runId: `citation-${streaming}`, threadId: "thread-1" },
              }),
            },
          },
        }),
      },
      driver: { run: () => text },
      hooks: {
        "agent:finish"(event) {
          return event.reply(streaming ? (async function* () { for (const character of text) yield character })() : text)
        },
      },
    })
    await runAgentTrigger(agent, runtimeContext(), "support.message", {})
    expect(delivered).toEqual(["Verified answer. [source link unavailable] See [PR #1188](https://github.com/acme/portal/pull/1188)."])
  })

  it("leaves event.message undefined without a Channel", async () => {
    let message: unknown = "unset"
    const agent = defineAgent({
      driver: { run: () => "ok" },
      hooks: {
        "agent:finish"(event) {
          message = event.message
        },
      },
    })

    await runAgent(agent, runtimeContext(), { prompt: "hello" })
    expect(message).toBeUndefined()
  })

  it("rejects message methods that use reserved names or invalid shapes", () => {
    expect(() => defineChannel("bad", { message: { methods: { data: (() => undefined) as never } } })).toThrow(/reserved name/)
    expect(() => defineChannel("bad", { message: { methods: { tag: { handler: () => undefined } as never } } })).toThrow(/must be a function or \{ read: true, handler \}/)
  })
})
