import { describe, expect, it, vi } from "vitest"

import { createMessage, getMessageText } from "../src/messages.ts"

const runtime = () => ({
  memo: vi.fn(),
  runtime: "unknown" as const,
  runtimeConfig: {},
  waitUntil: vi.fn(),
})

describe("chatSummary", () => {
  it("registers a summary command by default", async () => {
    const { chatSummary } = await import("../src/capabilities.ts")

    expect(chatSummary().metadata).toEqual({
      commands: {
        summary: { description: "Summarize this conversation." },
      },
      trigger: "/",
    })
  })

  it("lets developers opt out of the command surface", async () => {
    const { chatSummary } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")

    const resolved = await resolveAgentCapabilities({
      capabilities: [chatSummary({ command: false })],
    }, runtime(), { prompt: "/summary" })

    expect(chatSummary({ command: false }).metadata).toBeUndefined()
    expect(resolved.input.prompt).toBe("/summary")
  })

  it("replaces the explicit summary command with generated summary context", async () => {
    const { chatSummary } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const execute = vi.fn(() => "User wants a sidebar title and a future summary command.")

    const first = createMessage({ role: "user", text: "We need chat titles in the sidebar." })
    const assistant = createMessage({ role: "assistant", text: "Use metadata events." })
    const latest = createMessage({ id: "latest", role: "user", text: "/summary focus on decisions" })
    const resolved = await resolveAgentCapabilities({
      capabilities: [chatSummary({ execute })],
    }, runtime(), { messages: [first, assistant, latest] })

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      args: "focus on decisions",
      messages: [first, assistant],
      text: [
        "user: We need chat titles in the sidebar.",
        "assistant: Use metadata events.",
      ].join("\n"),
    }))
    expect(getMessageText(resolved.input.messages![2]!)).toBe([
      "Conversation summary:",
      "User wants a sidebar title and a future summary command.",
    ].join("\n"))
    expect(resolved.input.context?.chatSummary).toEqual({
      summary: "User wants a sidebar title and a future summary command.",
    })
  })

  it("exposes generated summaries through finish extensions", async () => {
    const { chatSummary } = await import("../src/capabilities.ts")
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const agent = defineAgent({
      capabilities: [chatSummary({ execute: () => "Summary for finish hook." })],
      hooks: {
        "agent:finish": finish,
      },
      run: ({ messages }) => ({ text: getMessageText(messages.at(-1)!) }),
    })

    await expect(runAgent(agent, runtime(), {
      messages: [
        createMessage({ role: "user", text: "Original request" }),
        createMessage({ role: "user", text: "/summary" }),
      ],
    })).resolves.toEqual({
      text: "Conversation summary:\nSummary for finish hook.",
    })

    expect(finish.mock.calls[0]![0].extensions.get("chat-summary")).toEqual({
      summary: "Summary for finish hook.",
    })
  })
})
