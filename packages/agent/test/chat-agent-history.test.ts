import { afterEach, describe, expect, it, vi } from "vitest"
import { Chat } from "chat"

import { createAgentDirectMessageHook } from "../src/chat/agent-handoff.ts"

import type { Message } from "@vitehub/agent"

afterEach(() => {
  vi.restoreAllMocks()
})

function chatMessage(id: string, text: string, isMe = false) {
  return {
    id,
    author: { isMe },
    metadata: { dateSent: new Date("2026-05-19T00:00:00.000Z") },
    text,
  }
}

function runtime(platform?: string) {
  return {
    memo: <T>(_key: string, create: () => T) => create(),
    platform,
    runtime: "nitro" as const,
    runtimeConfig: {},
    waitUntil: () => {},
  }
}

function createState() {
  return {
    acquireLock: vi.fn(),
    appendToList: vi.fn(),
    connect: vi.fn(),
    delete: vi.fn(),
    dequeue: vi.fn(),
    disconnect: vi.fn(),
    enqueue: vi.fn(),
    extendLock: vi.fn(),
    forceReleaseLock: vi.fn(),
    get: vi.fn(),
    getList: vi.fn(),
    isSubscribed: vi.fn(),
    queueDepth: vi.fn(),
    releaseLock: vi.fn(),
    set: vi.fn(),
    setIfNotExists: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  }
}

describe("chat agent history", () => {
  it("requires explicit concurrency for agent chat bindings", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const { defineChat, resolveChat } = await import("../src/chat/index.ts")

    await expect(resolveChat(defineChat({
      adapters: {},
      agent: {
        definition: defineAgent({
          async run() {
            return "ok"
          },
        }),
        name: "support-agent",
      },
      state: createState() as never,
      userName: "support",
    }), runtime())).rejects.toThrow("must set concurrency explicitly")
  })

  it("keeps the current message when maxMessages is zero", async () => {
    let messages: Message[] | undefined
    const current = chatMessage("m3", "current")
    const agent = {
      generate: vi.fn(),
      name: "history-agent",
      stream: vi.fn(async (context: { messages: Message[] }) => {
        messages = context.messages
        return "ok"
      }),
    }
    const thread = {
      id: "thread-1",
      recentMessages: [
        chatMessage("m1", "old"),
        chatMessage("m2", "assistant", true),
        current,
      ],
      post: vi.fn(async () => ({ edit: vi.fn() })),
      refresh: vi.fn(async () => {}),
    }
    const hook = createAgentDirectMessageHook(
      {} as never,
      runtime(),
      {
        definition: agent as never,
        history: { maxMessages: 0, source: "thread" },
        name: "history-agent",
      },
      undefined,
    )

    await hook({
      bot: {} as never,
      channel: { id: "channel-1" } as never,
      message: current as never,
      thread: thread as never,
      workflow: undefined,
    })

    expect(messages?.map(message => message.id)).toEqual(["m3"])
  })

  it("bounds thread history to the requested number of messages", async () => {
    let messages: Message[] | undefined
    const current = chatMessage("m3", "current")
    const agent = {
      generate: vi.fn(),
      name: "history-agent",
      stream: vi.fn(async (context: { messages: Message[] }) => {
        messages = context.messages
        return "ok"
      }),
    }
    const thread = {
      id: "thread-1",
      recentMessages: [
        chatMessage("m1", "old"),
        chatMessage("m2", "assistant", true),
        current,
      ],
      post: vi.fn(async () => ({ edit: vi.fn() })),
      refresh: vi.fn(async () => {}),
    }
    const hook = createAgentDirectMessageHook(
      {} as never,
      runtime(),
      {
        definition: agent as never,
        history: { maxMessages: 2, source: "thread" },
        name: "history-agent",
      },
      undefined,
    )

    await hook({
      bot: {} as never,
      channel: { id: "channel-1" } as never,
      message: current as never,
      thread: thread as never,
      workflow: undefined,
    })

    expect(messages?.map(message => message.id)).toEqual(["m2", "m3"])
  })

  it("does not edit placeholders with empty text when the agent stream has no text deltas", async () => {
    const edit = vi.fn(async (message: unknown) => {
      if (message === "") {
        throw new Error("empty placeholder edit")
      }
    })
    const agent = {
      generate: vi.fn(),
      name: "stream-agent",
      stream: vi.fn(async () => (async function* () {
        yield { id: "call-1", input: { path: "README.md" }, name: "read_file", type: "tool-call" }
        yield { id: "call-1", name: "read_file", output: "contents", type: "tool-result" }
        yield { reason: "tool-calls", type: "finish" }
      })()),
    }
    const thread = {
      id: "thread-1",
      post: vi.fn(async () => ({ edit })),
    }
    const hook = createAgentDirectMessageHook(
      {} as never,
      runtime(),
      {
        definition: agent as never,
        name: "stream-agent",
      },
      undefined,
      { fallbackStreamingPlaceholderText: "Thinking..." },
    )

    await hook({
      bot: {} as never,
      channel: { id: "channel-1" } as never,
      message: chatMessage("m1", "help") as never,
      thread: thread as never,
      workflow: undefined,
    })

    expect(edit).toHaveBeenCalledWith(expect.stringMatching(/\S/))
  })

  it("passes a devtools tool reporter and timeout to devtools chat agent runs", async () => {
    let timeout: number | undefined
    const statuses: string[] = []
    const agent = {
      generate: vi.fn(),
      name: "devtools-agent",
      stream: vi.fn(async (context: { devtools?: { reportToolStep?: (step: unknown) => Promise<void> }, input: { timeout?: number } }) => {
        timeout = context.input.timeout
        await context.devtools?.reportToolStep?.({
          toolCalls: [{ input: { path: "README.md" }, toolCallId: "call-1", toolName: "read_file" }],
        })
        await context.devtools?.reportToolStep?.({
          toolResults: [{ input: { path: "README.md" }, output: "contents", toolCallId: "call-1", toolName: "read_file" }],
        })
        return "ok"
      }),
    }
    const thread = {
      adapter: { name: "devtools" },
      id: "thread-1",
      post: vi.fn(async () => ({ edit: vi.fn() })),
      startTyping: vi.fn(async (status: string) => { statuses.push(status) }),
    }
    const hook = createAgentDirectMessageHook(
      {} as never,
      runtime("devtools"),
      {
        definition: agent as never,
        name: "devtools-agent",
      },
      undefined,
    )

    await hook({
      bot: {} as never,
      channel: { id: "channel-1" } as never,
      message: chatMessage("m1", "help") as never,
      thread: thread as never,
      workflow: undefined,
    })

    expect(timeout).toBe(90_000)
    expect(statuses.map(status => JSON.parse(status))).toEqual([
      expect.objectContaining({ id: "call-1", input: { path: "README.md" }, name: "read_file", status: "running" }),
      expect.objectContaining({ id: "call-1", input: { path: "README.md" }, name: "read_file", output: "contents", status: "completed" }),
    ])
  })

  it("wraps devtools thread streams so tool parts are reported automatically", async () => {
    const { defineChat, resolveChat } = await import("../src/chat/index.ts")
    const directMessageSpy = vi.spyOn(Chat.prototype, "onDirectMessage")
    const statuses: string[] = []
    const posted: unknown[] = []

    await resolveChat(defineChat({
      adapters: {},
      hooks: {
        onDirectMessage: async ({ thread }) => {
          await thread.post((async function* () {
            yield { id: "call-1", toolName: "read_file", type: "tool-input-start" }
            yield { input: { path: "README.md" }, toolCallId: "call-1", toolName: "read_file", type: "tool-call" }
            yield { input: { path: "README.md" }, output: "contents", toolCallId: "call-1", toolName: "read_file", type: "tool-result" }
          })())
        },
      },
      state: createState() as never,
      userName: "ViteHub Chat",
    }), runtime() as never)

    const handler = directMessageSpy.mock.calls[0]?.[0]
    await handler?.({
      adapter: { name: "devtools" },
      id: "thread-1",
      post: async (message: AsyncIterable<unknown>) => {
        posted.push(message)
        for await (const _part of message) {}
      },
      startTyping: async (status: string) => {
        statuses.push(status)
      },
    } as never, chatMessage("m1", "help") as never, { id: "channel-1" } as never)

    expect(posted).toHaveLength(1)
    expect(statuses.map(status => JSON.parse(status))).toEqual([
      expect.objectContaining({ id: "call-1", name: "read_file", status: "running" }),
      expect.objectContaining({ id: "call-1", input: { path: "README.md" }, name: "read_file", status: "running" }),
      expect.objectContaining({ id: "call-1", name: "read_file", output: "contents", status: "completed" }),
    ])
  })
})
