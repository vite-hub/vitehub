import { describe, expect, it } from "vitest"

import { createChatMessageTriggerInput } from "../src/chat-message-input.ts"

describe("chat message trigger input", () => {
  it("selects manual Chat Session history and carries chat context", () => {
    const result = createChatMessageTriggerInput({
      sessions: true,
      triggerHistory: { maxMessages: 10, source: "thread" },
    }, {
      messages: [
        { metadata: { sessionId: "a" }, parts: [{ text: "session a", type: "text" }], role: "user" },
        { metadata: { sessionId: "b" }, parts: [{ text: "session b", type: "text" }], role: "user" },
      ],
      session: { id: "b" },
      meta: { email: "support@example.com" },
      user: { id: "user_1" },
    })

    expect(result.input.context?.chat).toMatchObject({
      meta: { email: "support@example.com" },
      session: { id: "b" },
      user: { id: "user_1" },
    })
    expect(result.input.context?.channel).toMatchObject({
      meta: { email: "support@example.com" },
      session: { id: "b" },
      user: { id: "user_1" },
    })
    expect(result.input.context).not.toHaveProperty("chat.identity")
    expect(result.input.context?.invoker).toMatchObject({
      email: {
        address: "support@example.com",
        domain: "example.com",
      },
      id: "user_1",
      kind: "chat",
      meta: {
        email: "support@example.com",
        id: "user_1",
      },
    })
    expect(result.input.messages?.map(message => message.parts
      .filter((part): part is { text: string, type: "text" } => part.type === "text")
      .map(part => part.text)
      .join(""))).toEqual(["session b"])
    expect(result.hookArgs.message.text).toBe("session b")
  })

  it("derives trigger history from explicit thread history", () => {
    const result = createChatMessageTriggerInput({
      threadHistory: { maxMessages: 2 },
    }, {
      messages: [
        { parts: [{ text: "one", type: "text" }], role: "user" },
        { parts: [{ text: "two", type: "text" }], role: "assistant" },
        { parts: [{ text: "three", type: "text" }], role: "user" },
      ],
    })

    expect(result.input.messages?.map(message => message.parts
      .filter((part): part is { text: string, type: "text" } => part.type === "text")
      .map(part => part.text)
      .join(""))).toEqual(["two", "three"])
  })

  it("lets trigger history override derived thread history", () => {
    const result = createChatMessageTriggerInput({
      threadHistory: { maxMessages: 10 },
      triggerHistory: { maxMessages: 1, source: "thread" },
    }, {
      messages: [
        { parts: [{ text: "one", type: "text" }], role: "user" },
        { parts: [{ text: "two", type: "text" }], role: "assistant" },
      ],
    })

    expect(result.input.messages?.map(message => message.parts
      .filter((part): part is { text: string, type: "text" } => part.type === "text")
      .map(part => part.text)
      .join(""))).toEqual(["two"])
  })

  it("keeps stateless trigger history explicit", () => {
    const result = createChatMessageTriggerInput({
      threadHistory: { maxMessages: 10 },
      triggerHistory: "none",
    }, {
      messages: [
        { parts: [{ text: "one", type: "text" }], role: "user" },
        { parts: [{ text: "two", type: "text" }], role: "assistant" },
      ],
    })

    expect(result.input.messages?.map(message => message.parts
      .filter((part): part is { text: string, type: "text" } => part.type === "text")
      .map(part => part.text)
      .join(""))).toEqual(["two"])
  })

  it("uses Chat Trigger metadata to enrich a user-derived invoker", () => {
    const result = createChatMessageTriggerInput({}, {
      messages: [{ parts: [{ text: "hello", type: "text" }], role: "user" }],
      meta: {
        customer: "acme",
        email: "support@example.com",
      },
      user: { email: "support@example.com" },
    })

    expect(result.input.context).not.toHaveProperty("chat.identity")
    expect(result.input.context?.invoker).toEqual({
      email: {
        address: "support@example.com",
        domain: "example.com",
      },
      id: "support@example.com",
      kind: "chat",
      meta: {
        customer: "acme",
        email: "support@example.com",
      },
    })
  })

  it("uses an explicit Chat Trigger invoker without lifting chat metadata into it", () => {
    const result = createChatMessageTriggerInput({}, {
      invoker: {
        id: "portal:acme:user_1",
        kind: "customerPortal",
        meta: {
          email: "support@example.com",
          scope: "acme",
        },
      },
      messages: [{ parts: [{ text: "hello", type: "text" }], role: "user" }],
      meta: { portal: { activePage: "/orders" } },
      run: { origin: "portal", runId: "portal-run" },
      user: { email: "support@example.com" },
    })

    expect(result.input.context?.chat).toMatchObject({
      meta: { portal: { activePage: "/orders" } },
      user: { email: "support@example.com" },
    })
    expect(result.input.context?.chat).not.toHaveProperty("run")
    expect(result.input.context?.channel).toMatchObject({
      meta: { portal: { activePage: "/orders" } },
      run: { origin: "portal", runId: "portal-run" },
      user: { email: "support@example.com" },
    })
    expect(result.input.context?.invoker).toEqual({
      email: {
        address: "support@example.com",
        domain: "example.com",
      },
      id: "portal:acme:user_1",
      kind: "customerPortal",
      meta: {
        email: "support@example.com",
        scope: "acme",
      },
    })
  })

  it("preserves Chat Trigger metadata without creating an invoker from metadata alone", () => {
    const result = createChatMessageTriggerInput({}, {
      messages: [{ parts: [{ text: "hello", type: "text" }], role: "user" }],
      meta: { email: "support@example.com" },
    })

    expect(result.input.context?.chat).toMatchObject({
      meta: { email: "support@example.com" },
    })
    expect(result.input.context).not.toHaveProperty("chat.identity")
    expect(result.input.context?.invoker).toBeUndefined()
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

  it("preserves requested UI tool approvals", () => {
    const result = createChatMessageTriggerInput({}, {
      messages: [{
        parts: [{
          approval: { id: "approval-1" },
          input: { command: "write" },
          state: "approval-requested",
          toolCallId: "tool-1",
          toolName: "shell",
          type: "dynamic-tool",
        }],
        role: "assistant",
      }],
    })

    expect(result.input.messages?.[0]?.parts).toEqual([{
      id: "approval-1",
      input: { command: "write" },
      name: "shell",
      toolCallId: "tool-1",
      type: "approval-request",
    }])
  })

  it("preserves responded UI tool approvals", () => {
    const result = createChatMessageTriggerInput({}, {
      messages: [{
        parts: [{
          approval: { approved: false, id: "approval-1", reason: "Use read-only mode." },
          input: { command: "write" },
          state: "approval-responded",
          toolCallId: "tool-1",
          type: "tool-shell",
        }],
        role: "assistant",
      }],
    })

    expect(result.input.messages?.[0]?.parts).toEqual([
      { id: "approval-1", input: { command: "write" }, name: "shell", toolCallId: "tool-1", type: "approval-request" },
      { approved: false, id: "approval-1", reason: "Use read-only mode.", type: "approval-decision" },
    ])
  })

  it("preserves UI data parts in follow-up history", () => {
    const result = createChatMessageTriggerInput({}, {
      messages: [{
        parts: [
          { data: { city: "Seattle" }, id: "weather-1", type: "data-weather" },
          { text: "The forecast is ready.", type: "text" },
        ],
        role: "assistant",
      }],
    })

    expect(result.input.messages?.[0]?.parts).toEqual([
      { data: { city: "Seattle" }, id: "weather-1", type: "data-weather" },
      { id: "text-1", text: "The forecast is ready.", type: "text" },
    ])
  })

  it("preserves failed UI tool calls", () => {
    const result = createChatMessageTriggerInput({}, {
      messages: [{
        parts: [{
          errorText: "lookup failed",
          input: { query: "users" },
          state: "output-error",
          toolCallId: "tool-1",
          toolName: "search",
          type: "dynamic-tool",
        }],
        role: "assistant",
      }],
    })

    expect(result.input.messages?.[0]?.parts).toEqual([
      { id: "tool-1", input: { query: "users" }, name: "search", state: "proposed", type: "tool-call" },
      { error: "lookup failed", id: "tool-1", name: "search", state: "failed", type: "tool-result" },
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
