import { describe, expect, it, vi } from "vitest"

import { createAgentDirectMessageHook } from "../src/chat/agent-handoff.ts"

import type { Message } from "@vitehub/agent"

function chatMessage(id: string, text: string, isMe = false) {
  return {
    id,
    author: { isMe },
    metadata: { dateSent: new Date("2026-05-19T00:00:00.000Z") },
    text,
  }
}

describe("chat agent history", () => {
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
      {
        memo: (_key, create) => create(),
        runtime: "nitro",
        runtimeConfig: {},
        waitUntil: () => {},
      },
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
      runtimeConfig: {},
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
      {
        memo: (_key, create) => create(),
        runtime: "nitro",
        runtimeConfig: {},
        waitUntil: () => {},
      },
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
      runtimeConfig: {},
      thread: thread as never,
      workflow: undefined,
    })

    expect(messages?.map(message => message.id)).toEqual(["m2", "m3"])
  })
})
