import { describe, expect, it, vi } from "vitest"

import { createMessage } from "@vitehub/messages"

describe("agent capabilities", () => {
  it("runs capabilities once in array order and mutates adapter context", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { defineCapability } = await import("../src/capabilities.ts")
    const order: string[] = []

    const agent = defineAgent({
      adapter: {
        async generate(context) {
          order.push("adapter")
          return { text: context.messages.map(message => message.parts.map(part => part.type === "text" ? part.text : "").join("")).join("") }
        },
        name: "test",
      },
      capabilities: [
        defineCapability({
          id: "first",
          input(context) {
            order.push("first")
            context.input.setMessages([
              createMessage({ role: "user", text: "a" }),
            ])
          },
        }),
        defineCapability({
          id: "second",
          input(context) {
            order.push("second")
            context.input.setMessages([
              ...context.input.messages(),
              createMessage({ role: "user", text: "b" }),
            ])
          },
        }),
      ],
    })

    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {})).resolves.toMatchObject({ text: "ab" })
    expect(order).toEqual(["first", "second", "adapter"])
  })

  it("renders explicit capability instruction slots and appends remaining blocks", async () => {
    const { applyCapabilityInstructionSlots } = await import("../src/capabilities.ts")

    expect(applyCapabilityInstructionSlots("Base\n{{ mcp }}", [
      { id: "skills", instructions: "Skills block" },
      { id: "mcp", instructions: "MCP block" },
    ])).toBe("Base\nMCP block\n\nSkills block")
  })

  it("throws on duplicate capability ids", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { defineCapability } = await import("../src/capabilities.ts")
    const capability = defineCapability({ id: "same" })
    const agent = defineAgent({
      adapter: { generate: async () => ({ text: "ok" }), name: "test" },
      capabilities: [capability, capability],
    })

    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {})).rejects.toThrow("Duplicate agent capability")
  })

  it("transcribes audio input before adapter execution", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { voiceInput } = await import("../src/capabilities.ts")
    const transcribe = vi.fn(async () => "voice transcript")
    const agent = defineAgent({
      adapter: {
        async generate(context) {
          return { text: context.messages.map(message => message.parts.filter(part => part.type === "text").map(part => part.text).join("")).join("") }
        },
        name: "test",
      },
      capabilities: [voiceInput({ transcribe })],
    })

    await expect(runAgent(agent, { memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }, {
      messages: [createMessage({
        parts: [{ data: "AAAA", mediaType: "audio/wav", type: "audio" }],
        role: "user",
      })],
    })).resolves.toMatchObject({ text: "voice transcript" })
    expect(transcribe).toHaveBeenCalledWith(expect.objectContaining({ mediaType: "audio/wav" }))
  })
})
