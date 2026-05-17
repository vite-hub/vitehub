import { describe, expect, it } from "vitest"

import {
  applyAgentStreamEvent,
  createAgentMessage,
  deserializeAgentMessages,
  getAgentMessageText,
  getAgentToolInvocations,
  serializeAgentMessages,
  validateAgentMessage,
} from "../src/messages.ts"

describe("agent message primitives", () => {
  it("creates normalized text messages", () => {
    const message = createAgentMessage({ id: "m1", role: "user", text: "hello" })

    expect(message).toMatchObject({
      id: "m1",
      parts: [{ id: "text-0", text: "hello", type: "text" }],
      role: "user",
    })
    expect(getAgentMessageText(message)).toBe("hello")
  })

  it("applies text stream events into message state", () => {
    let messages = [] as ReturnType<typeof createAgentMessage>[]

    messages = applyAgentStreamEvent(messages, { messageId: "m1", text: "hel", type: "text-delta" })
    messages = applyAgentStreamEvent(messages, { messageId: "m1", text: "lo", type: "text-delta" })

    expect(messages).toHaveLength(1)
    expect(getAgentMessageText(messages[0]!)).toBe("hello")
  })

  it("does not append assistant stream events to a trailing user message without messageId", () => {
    const messages = applyAgentStreamEvent(
      [createAgentMessage({ id: "user-1", role: "user", text: "hello" })],
      { text: "assistant reply", type: "text-delta" },
    )

    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ id: "user-1", role: "user" })
    expect(getAgentMessageText(messages[0]!)).toBe("hello")
    expect(messages[1]).toMatchObject({ role: "assistant" })
    expect(getAgentMessageText(messages[1]!)).toBe("assistant reply")
  })

  it("tracks tool call lifecycle", () => {
    let messages = [createAgentMessage({ id: "m1", parts: [], role: "assistant" })]

    messages = applyAgentStreamEvent(messages, { id: "call-1", input: { city: "Stockholm" }, messageId: "m1", name: "weather", type: "tool-call" })
    messages = applyAgentStreamEvent(messages, { id: "call-1", messageId: "m1", name: "weather", output: { temp: 10 }, type: "tool-result" })

    expect(getAgentToolInvocations(messages[0]!)).toEqual([
      { id: "call-1", name: "weather", output: { temp: 10 }, state: "completed" },
    ])
  })

  it("tracks approval requests", () => {
    let messages = [createAgentMessage({ id: "m1", parts: [], role: "assistant" })]

    messages = applyAgentStreamEvent(messages, { id: "call-1", input: { amount: 100 }, messageId: "m1", name: "refund", reason: "Needs approval", type: "approval-request" })

    expect(messages[0]?.parts).toEqual([
      { id: "call-1", input: { amount: 100 }, name: "refund", reason: "Needs approval", type: "approval-request" },
    ])
  })

  it("tracks approval decisions", () => {
    let messages = [createAgentMessage({ id: "m1", parts: [], role: "assistant" })]

    messages = applyAgentStreamEvent(messages, { id: "call-1", input: { amount: 100 }, messageId: "m1", name: "refund", type: "approval-request" })
    messages = applyAgentStreamEvent(messages, { approved: true, decidedAt: new Date("2026-05-09T10:00:00.000Z"), id: "call-1", messageId: "m1", type: "approval-decision" })

    expect(messages[0]?.parts).toEqual([
      { id: "call-1", input: { amount: 100 }, name: "refund", type: "approval-request" },
      { approved: true, decidedAt: "2026-05-09T10:00:00.000Z", id: "call-1", type: "approval-decision" },
    ])
  })

  it("serializes and deserializes validated messages", () => {
    const messages = [createAgentMessage({ id: "m1", role: "user", text: "hello" })]
    const serialized = serializeAgentMessages(messages)

    expect(deserializeAgentMessages(serialized)).toEqual(messages)
  })

  it("rejects non-serializable message state", () => {
    expect(() => validateAgentMessage({
      id: "m1",
      metadata: { skipped: undefined },
      parts: [],
      role: "user",
    })).toThrow("must not be undefined")
  })

  it("does not persist explicit undefined fields from stream events", () => {
    const messages = applyAgentStreamEvent(
      [createAgentMessage({ id: "m1", parts: [], role: "assistant" })],
      { id: "call-1", messageId: "m1", name: "weather", type: "tool-call" },
    )

    expect(messages[0]?.parts[0]).toEqual({
      id: "call-1",
      name: "weather",
      state: "proposed",
      type: "tool-call",
    })
  })

  it("rejects tool results without a matching call", () => {
    expect(() => validateAgentMessage({
      id: "m1",
      parts: [{ id: "call-1", name: "weather", state: "completed", type: "tool-result" }],
      role: "assistant",
    })).toThrow("must follow a matching tool-call")
  })

  it("rejects approval decisions without a matching request", () => {
    expect(() => validateAgentMessage({
      id: "m1",
      parts: [{ approved: true, id: "call-1", type: "approval-decision" }],
      role: "assistant",
    })).toThrow("must follow a matching approval-request")
  })
})
