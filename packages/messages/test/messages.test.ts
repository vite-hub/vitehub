import { describe, expect, it } from "vitest"

import {
  applyStreamEvent,
  createMessage,
  deserializeMessages,
  getMessageText,
  getToolInvocations,
  serializeMessages,
  validateMessage,
} from "../src/index.ts"

describe("@vitehub/messages", () => {
  it("creates normalized text messages", () => {
    const message = createMessage({ id: "m1", role: "user", text: "hello" })

    expect(message).toMatchObject({
      id: "m1",
      parts: [{ id: "text-0", text: "hello", type: "text" }],
      role: "user",
    })
    expect(getMessageText(message)).toBe("hello")
  })

  it("applies text stream events into message state", () => {
    let messages = [] as ReturnType<typeof createMessage>[]

    messages = applyStreamEvent(messages, { messageId: "m1", text: "hel", type: "text-delta" })
    messages = applyStreamEvent(messages, { messageId: "m1", text: "lo", type: "text-delta" })

    expect(messages).toHaveLength(1)
    expect(getMessageText(messages[0]!)).toBe("hello")
  })

  it("tracks tool call lifecycle", () => {
    let messages = [createMessage({ id: "m1", parts: [], role: "assistant" })]

    messages = applyStreamEvent(messages, { id: "call-1", input: { city: "Stockholm" }, messageId: "m1", name: "weather", type: "tool-call" })
    messages = applyStreamEvent(messages, { id: "call-1", messageId: "m1", name: "weather", output: { temp: 10 }, type: "tool-result" })

    expect(getToolInvocations(messages[0]!)).toEqual([
      { id: "call-1", name: "weather", output: { temp: 10 }, state: "completed" },
    ])
  })

  it("tracks approval requests", () => {
    let messages = [createMessage({ id: "m1", parts: [], role: "assistant" })]

    messages = applyStreamEvent(messages, { id: "call-1", input: { amount: 100 }, messageId: "m1", name: "refund", reason: "Needs approval", type: "approval-request" })

    expect(messages[0]?.parts).toEqual([
      { id: "call-1", input: { amount: 100 }, name: "refund", reason: "Needs approval", type: "approval-request" },
    ])
  })

  it("serializes and deserializes validated messages", () => {
    const messages = [createMessage({ id: "m1", role: "user", text: "hello" })]
    const serialized = serializeMessages(messages)

    expect(deserializeMessages(serialized)).toEqual(messages)
  })

  it("rejects tool results without a matching call", () => {
    expect(() => validateMessage({
      id: "m1",
      parts: [{ id: "call-1", name: "weather", state: "completed", type: "tool-result" }],
      role: "assistant",
    })).toThrow("must follow a matching tool-call")
  })
})
