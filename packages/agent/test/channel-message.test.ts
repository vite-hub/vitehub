import { describe, expect, it, vi } from "vitest"
import * as v from "valibot"

import { createTraceEventLog } from "@vite-hub/runtime"
import { defineChannel, github, slack, telegram, webChat } from "../src/channels.ts"
import { withAgentChannelDeliveryOwnershipVerifier } from "../src/internal/channel-delivery.ts"
import { channelMessageContextKey } from "../src/internal/channel-delivery-handlers.ts"
import { defineAgent, runAgent, runAgentTrigger } from "../src/index.ts"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "../src/server.ts"
import { createChannelChatRouteHandler } from "../src/server/internal.ts"
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
  it.each([
    ["webhook", false], ["webhook", true],
    ["dev", false], ["dev", true],
    ["dev-context", false], ["dev-context", true],
  ] as const)("supplies GitHub message data to hooks (%s, error: %s)", async (source, fail) => {
    const label = vi.fn()
    const messageData = v.object({
      repository: v.object({ fullName: v.string() }),
      pullRequest: v.object({ number: v.number() }),
      trigger: v.object({ comment: v.object({ id: v.number() }) }),
    })
    const agent = defineAgent({
      channels: {
        github: github({
          pullRequest: { workspace: false, reply: false },
          message: {
            data: messageData,
            methods: {
              label: (context, value: string) => label(context.message, value),
            },
          },
        }),
      },
      driver: { run: () => {
        if (fail) throw new Error("driver failed")
        return "ok"
      } },
      hooks: {
        async "agent:finish"(event) {
          if (!event.message) throw new Error("expected a GitHub message")
          await event.message.label("finished")
        },
        async "agent:error"(event) {
          if (!event.message) throw new Error("expected a GitHub message")
          await event.message.label("failed")
        },
      },
    })
    const payload = {
      action: "created",
      comment: { body: "/review please", id: 99, user: { login: "mona", type: "User" } },
      issue: {
        number: 42,
        pull_request: { url: "https://api.github.test/repos/acme/app/pulls/42" },
      },
      repository: { full_name: "acme/app" },
    }
    const input = source === "dev-context" ? {
      pullRequest: {
        repository: { fullName: "acme/app", name: "app", owner: "acme" },
        pullRequest: {
          apiUrl: "https://api.github.test/repos/acme/app/pulls/42",
          number: 42,
          source: { checkout: false, mount: "", ref: "refs/pull/42/head", repo: "acme/app" },
        },
        run: { messageId: "99", origin: "github-pull-request-comment", threadId: "pr-42" },
        trigger: { action: "created", actor: { login: "mona" }, args: "please", command: "/review", comment: { id: 99 }, event: "issue_comment" },
      },
    } : { payload }
    const invocation = runAgentTrigger(agent, runtimeContext(), `github.${source === "webhook" ? "webhook" : "dev"}`, input)
    if (fail) await expect(invocation).rejects.toThrow("driver failed")
    else await expect(invocation).resolves.toBe("ok")
    expect(label).toHaveBeenCalledWith({
      repository: { fullName: "acme/app" },
      pullRequest: { number: 42 },
      trigger: { comment: { id: 99 } },
    }, fail ? "failed" : "finished")
  })

  it.each([false, true])("supplies generated webChat message data to hooks (error: %s)", async (fail) => {
    const label = vi.fn()
    const seen: unknown[] = []
    const agent = defineAgent({
      channels: {
        portal: webChat({
          message: {
            data: v.object({ id: v.string(), text: v.string(), metadata: v.object({ category: v.string() }) }),
            methods: {
              label: (context, value: string) => label(context.message.id, value),
            },
          },
        }),
      },
      driver: { run: () => {
        if (fail) throw new Error("driver failed")
        return "ok"
      } },
      hooks: {
        async "agent:finish"(event) {
          if (!event.message) throw new Error("expected a Channel message")
          seen.push("finish", event.message.channel, event.message.data)
          await event.message.label("finished")
        },
        async "agent:error"(event) {
          if (!event.message) throw new Error("expected a Channel message")
          seen.push("error", event.message.channel, event.message.data)
          await event.message.label("failed")
        },
      },
    })
    // SAFETY: The generated route accepts this host-independent Agent through its internal host boundary.
    const handler = createChannelChatRouteHandler(agent as never)
    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: `thread-${fail}`,
        messages: [{ id: "message-1", role: "user", parts: [{ type: "text", text: "hello" }], metadata: { category: "support" } }],
      }),
    }), { agentName: "support" })
    expect(response.status).toBe(fail ? 500 : 200)
    const output = await response.text()
    expect(output).toContain(fail ? "Agent request failed." : "ok")
    expect(seen).toEqual([fail ? "error" : "finish", "portal", { id: "message-1", text: "hello", metadata: { category: "support" } }])
    expect(label).toHaveBeenCalledWith("message-1", fail ? "failed" : "finished")
  })

  it.each([false, true])("uses the current inbound message when a generated route selects another session (error: %s)", async fail => {
    const seen: unknown[] = []
    const history: unknown[] = []
    const agent = defineAgent({
      channels: {
        portal: webChat({
          messages: { sessions: { strategy: "manual" } },
          route: { admission: { authenticate: () => true }, input: { trust: ["session"] } },
          message: {
            data: v.object({ id: v.string(), text: v.string() }),
            methods: {},
          },
        }),
      },
      driver: { run: ({ input }) => {
        history.push(input.messages?.map(message => message.id))
        if (fail) throw new Error("driver failed")
        return "ok"
      } },
      hooks: {
        "agent:finish": event => {
          seen.push(event.message?.data)
        },
        "agent:error": event => {
          seen.push(event.message?.data)
        },
      },
    })
    // SAFETY: The generated route accepts this host-independent Agent through its internal host boundary.
    const handler = createChannelChatRouteHandler(agent as never)
    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [
          { id: "old-message", metadata: { sessionId: "old" }, parts: [{ type: "text", text: "old" }], role: "user" },
          { id: "current-message", metadata: { sessionId: "current" }, parts: [{ type: "text", text: "current" }], role: "user" },
        ],
        session: { id: "old" },
      }),
    }), { agentName: "support" })

    const responseText = await response.text()
    expect(response.status, responseText).toBe(fail ? 500 : 200)
    expect(seen).toEqual([{ id: "current-message", text: "current" }])
    expect(history).toEqual([["old-message"]])
  })

  it.each([false, true])("preserves the inbound message when mapInput rewrites Driver messages (error: %s)", async fail => {
    const seen: unknown[] = []
    const history: unknown[] = []
    const label = vi.fn()
    const agent = defineAgent({
      channels: {
        portal: webChat({
          route: {
            mapInput: ({ input }) => {
              const metadata = input.messages.at(-1)?.metadata
              if (typeof metadata === "object" && metadata !== null && "category" in metadata) metadata.category = "mapped"
              input.messages.push({ id: "mapped-message", role: "user", parts: [{ type: "text", text: "mapped" }] })
              return { messages: input.messages.slice(-1) }
            },
          },
          message: {
            data: v.object({ id: v.string(), text: v.string(), metadata: v.object({ category: v.string() }) }),
            methods: { label: (context, value: string) => label(context.message.id, value) },
          },
        }),
      },
      driver: { run: ({ input }) => {
        history.push(input.messages?.map(message => message.id))
        if (fail) throw new Error("driver failed")
        return "ok"
      } },
      hooks: {
        async "agent:finish"(event) {
          seen.push(event.message?.data)
          await event.message?.label("finished")
        },
        async "agent:error"(event) {
          seen.push(event.message?.data)
          await event.message?.label("failed")
        },
      },
    })
    // SAFETY: The generated route accepts this host-independent Agent through its internal host boundary.
    const handler = createChannelChatRouteHandler(agent as never)
    const response = await handler(new Request("https://example.com/api/_vitehub/agents/support/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ id: "current-message", role: "user", parts: [{ type: "text", text: "current" }], metadata: { category: "support" } }],
      }),
    }), { agentName: "support" })
    const responseText = await response.text()
    expect(response.status, responseText).toBe(fail ? 500 : 200)
    expect(seen).toEqual([{ id: "current-message", text: "current", metadata: { category: "support" } }])
    expect(label).toHaveBeenCalledWith("current-message", fail ? "failed" : "finished")
    expect(history).toEqual([["mapped-message"]])
  })

  it.each([false, true])("retains custom message methods on a Telegram helper with dryRun=%s", async dryRun => {
    const label = vi.fn((id: string, value: string) => `${id}:${value}`)
    const subject = vi.fn((id: string) => `subject:${id}`)
    const seen: unknown[] = []
    const support = telegram({
      allowedUserIds: [123],
      botToken: "test-token",
      messages: false,
      message: {
        data: v.object({ id: v.string() }),
        methods: {
          label: (context, value: string) => label(context.message.id, value),
          subject: { read: true, handler: context => subject(context.message.id) },
        },
      },
      triggers: {
        custom: {
          invoke: (context, input: { id: string }) => ({
            input: { dryRun, prompt: "classify message" },
            message: input,
            run: { channelId: context.trigger.channelId, origin: context.channel.kind, runId: `telegram-custom-${dryRun}` },
          }),
        },
      },
    })
    const agent = defineAgent({
      channels: { support },
      driver: { run: () => "Receipts" },
      hooks: {
        async "agent:finish"(event) {
          if (!event.message) throw new Error("expected a Channel message")
          seen.push(event.message.channel, event.message.kind, event.message.data)
          seen.push(await event.message.subject(), await event.message.label(String(event.text)))
        },
      },
    })
    await expect(runAgentTrigger(agent, runtimeContext(), "support.custom", { id: "m1" })).resolves.toBe("Receipts")
    expect(seen).toEqual(["support", "telegram", { id: "m1" }, "subject:m1", dryRun ? undefined : "m1:Receipts"])
    expect(subject).toHaveBeenCalledWith("m1")
    if (dryRun) expect(label).not.toHaveBeenCalled()
    else expect(label).toHaveBeenCalledWith("m1", "Receipts")
  })

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

  it.each([undefined, { id: "inherited" }])("validates omitted message data instead of inherited data %j", async (inheritedMessage) => {
    let reachedHook = false
    const agent = defineAgent({
      channels: {
        mail: defineChannel("mail", {
          message: { data: v.object({ id: v.string() }) },
          messages: false,
          triggers: {
            message: {
              invoke: () => ({ input: { context: inheritedMessage === undefined ? {} : { [channelMessageContextKey]: inheritedMessage }, prompt: "mail" } }),
            },
          },
        }),
      },
      driver: { run: () => "ok" },
      hooks: {
        "agent:finish"() {
          reachedHook = true
        },
      },
    })

    await expect(runAgentTrigger(agent, runtimeContext(), "mail.message", {})).rejects.toThrow(/Invalid Channel "mail" message data/)
    expect(reachedHook).toBe(false)
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

  it("fences custom writes after delivery ownership is lost but allows reads", async () => {
    const provider = { label: vi.fn(), subject: vi.fn(() => "Invoice") }
    const verifyOwnership = vi.fn(async () => { throw new Error("delivery ownership lost") })
    const agent = defineAgent({
      channels: { mail: mailChannel(provider) },
      driver: { run: () => "Receipts" },
      hooks: {
        async "agent:finish"(event) {
          expect(await event.message?.subject()).toBe("Invoice")
          await expect(event.message?.label({ add: ["Receipts"] })).rejects.toThrow("delivery ownership lost")
        },
      },
    })

    await runAgentTrigger(agent, withAgentChannelDeliveryOwnershipVerifier(runtimeContext(), verifyOwnership), "mail.message", { id: "m3" })
    expect(provider.subject).toHaveBeenCalledWith("m3")
    expect(provider.label).not.toHaveBeenCalled()
    expect(verifyOwnership).toHaveBeenCalledOnce()
  })

  it.each([false, true])("omits built-in reply without delivery support (disabled: %s)", async (disabled) => {
    const agent = defineAgent({
      channels: {
        slack: slack({
          adapter: disabled ? () => { throw new Error("disabled adapter must not run") } : undefined,
          messages: disabled ? false : undefined,
          triggers: { message: { invoke: () => ({ input: { prompt: "hello" } }) } },
        }),
      },
      driver: { run: () => "ok" },
      hooks: {
        "agent:finish"(event) {
          expect(event.message?.reply).toBeUndefined()
        },
      },
    })

    await runAgentTrigger(agent, runtimeContext(), "slack.message", {})
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

  it("preserves a Channel message method named __proto__", async () => {
    const invoked = vi.fn()
    const agent = defineAgent({
      channels: {
        mail: defineChannel("mail", {
          message: {
            methods: {
              ["__proto__"]: () => {
                invoked()
                return "ok"
              },
            },
          },
          messages: false,
          triggers: { message: { invoke: () => ({ input: { prompt: "hello" } }) } },
        }),
      },
      driver: { run: () => "ok" },
      hooks: {
        async "agent:finish"(event) {
          expect(await event.message?.["__proto__"]()).toBe("ok")
        },
      },
    })

    await runAgentTrigger(agent, runtimeContext(), "mail.message", {})
    expect(invoked).toHaveBeenCalledOnce()
  })

  it("keeps the built-in reply of Chat SDK Channels on event.message", async () => {
    const postMessage = vi.fn()
    const agent = defineAgent({
      channels: {
        portal: defineChannel("portal", {
          // SAFETY: This test fixture intentionally constructs the exact asserted runtime contract.
          adapter: { channelIdFromThreadId: (threadId: string) => threadId, postMessage } as never,
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

  it.each([false, true])("leaves event.message undefined for direct Channel delivery (error: %s)", async fail => {
    const seen: unknown[] = []
    const label = vi.fn()
    const agent = defineAgent({
      channels: { mail: mailChannel({ label, subject: () => "Invoice" }) },
      driver: { run: () => {
        if (fail) throw new Error("driver failed")
        return "ok"
      } },
      hooks: {
        "agent:finish"(event) { seen.push(event.message) },
        "agent:error"(event) { seen.push(event.message) },
      },
    })
    const invocation = runAgent(agent, { ...runtimeContext(), run: { channelId: "mail", runId: "direct-mail" } }, { prompt: "hello" })
    if (fail) await expect(invocation).rejects.toThrow("driver failed")
    else await expect(invocation).resolves.toBe("ok")
    expect(seen).toEqual([undefined])
    expect(label).not.toHaveBeenCalled()
  })

  it("delivers direct replies without validating absent Channel message data", async () => {
    const reply = vi.fn()
    const agent = defineAgent({
      channels: {
        mail: defineChannel("mail", {
          message: {
            data: v.object({ id: v.string() }),
            methods: {
              reply: (_context, input: string) => reply(input),
            },
          },
          messages: false,
        }),
      },
      driver: { run: () => "ok" },
      hooks: {
        "agent:finish": event => event.reply("done"),
      },
    })

    await expect(runAgent(agent, { ...runtimeContext(), run: { channelId: "mail", runId: "direct-reply" } }, { prompt: "hello" })).resolves.toBe("ok")
    expect(reply).toHaveBeenCalledWith("done")
  })

  it("rejects message methods that use reserved names or invalid shapes", () => {
    expect(() => defineChannel("bad", { message: { methods: { data: (() => undefined) as never } } })).toThrow(/reserved name/)
    expect(() => defineChannel("bad", { message: { methods: { then: (() => undefined) as never } } })).toThrow(/reserved name/)
    expect(() => defineChannel("bad", { message: { methods: { tag: { handler: () => undefined } as never } } })).toThrow(/must be a function or \{ read: true, handler \}/)
  })
})
