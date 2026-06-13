import { describe, expect, it } from "vitest"

import { createChatMessageTriggerInput } from "../src/chat-message-input.ts"

describe("chat message trigger input", () => {
  it("selects manual Chat Session history and carries chat context", () => {
    const result = createChatMessageTriggerInput({
      history: { maxMessages: 10, source: "thread" },
      sessions: true,
    }, {
      messages: [
        { metadata: { sessionId: "a" }, parts: [{ text: "session a", type: "text" }], role: "user" },
        { metadata: { sessionId: "b" }, parts: [{ text: "session b", type: "text" }], role: "user" },
      ],
      session: { id: "b" },
      user: { id: "user_1" },
    })

    expect(result.input.context?.chat).toMatchObject({
      session: { id: "b" },
      user: { id: "user_1" },
    })
    expect(result.input.context?.["chat.identity"]).toBe("user_1")
    expect(result.input.messages?.map(message => message.parts
      .filter((part): part is { text: string, type: "text" } => part.type === "text")
      .map(part => part.text)
      .join(""))).toEqual(["session b"])
    expect(result.hookArgs.message.text).toBe("session b")
  })

  it("preserves completed UI tool calls", () => {
    const result = createChatMessageTriggerInput({}, {
      messages: [{
        parts: [{
          input: { query: "users" },
          output: "42",
          state: "output-available",
          toolCallId: "tool-1",
          toolName: "search",
          type: "dynamic-tool",
        }],
        role: "assistant",
      }],
    })

    expect(result.input.messages?.[0]?.parts).toEqual([
      { id: "tool-1", input: { query: "users" }, name: "search", state: "proposed", type: "tool-call" },
      { id: "tool-1", name: "search", output: "42", state: "completed", type: "tool-result" },
    ])
  })

  it("drops incomplete UI tool calls from follow-up history", () => {
    const result = createChatMessageTriggerInput({}, {
      messages: [
        {
          parts: [
            { text: "I checked the workspace.", type: "text" },
            {
              input: { command: "rg safety" },
              state: "input-available",
              toolCallId: "tool-1",
              toolName: "shell",
              type: "dynamic-tool",
            },
          ],
          role: "assistant",
        },
        {
          parts: [{ text: "Follow up", type: "text" }],
          role: "user",
        },
      ],
    })

    expect(result.input.messages?.[0]?.parts.map(part => ({ text: "text" in part ? part.text : undefined, type: part.type }))).toEqual([
      { text: "I checked the workspace.", type: "text" },
    ])
    expect(result.input.messages?.[1]?.parts.map(part => ({ text: "text" in part ? part.text : undefined, type: part.type }))).toEqual([
      { text: "Follow up", type: "text" },
    ])
  })
})
