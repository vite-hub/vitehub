import { describe, expect, it, vi } from "vitest"

import { createMessage, getMessageText } from "../src/messages.ts"

const runtime = () => ({
  capabilities: {},
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

    const first = createMessage({ role: "user", text: "We need titles in the sidebar." })
    const assistant = createMessage({ role: "assistant", text: "Use metadata events." })
    const latest = createMessage({ id: "latest", role: "user", text: "/summary focus on decisions" })
    const resolved = await resolveAgentCapabilities({
      capabilities: [chatSummary({ execute })],
    }, runtime(), { messages: [first, assistant, latest] })

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      args: "focus on decisions",
      messages: [first, assistant],
      text: [
        "user: We need titles in the sidebar.",
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

  it("keeps normal user text around the summary command in source messages", async () => {
    const { chatSummary } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const execute = vi.fn(() => "Decision captured.")

    await resolveAgentCapabilities({
      capabilities: [chatSummary({ execute })],
    }, runtime(), {
      messages: [
        createMessage({ role: "assistant", text: "Earlier context" }),
        createMessage({ role: "user", text: "We decided to use metadata events. /summary" }),
      ],
    })

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      text: [
        "assistant: Earlier context",
        "user: We decided to use metadata events.",
      ].join("\n"),
    }))
  })

  it("builds prompt-mode summaries from the prompt text around the command", async () => {
    const { chatSummary } = await import("../src/capabilities.ts")
    const { resolveAgentCapabilities } = await import("../src/capability-runtime.ts")
    const execute = vi.fn(() => "Prompt summary.")

    await resolveAgentCapabilities({
      capabilities: [chatSummary({ execute })],
    }, runtime(), {
      prompt: "We decided to keep command UX with the capability. /summary focus on DX",
    })

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      args: "focus on DX",
      messages: [],
      text: "We decided to keep command UX with the capability.",
    }))
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
      driver: { run: ({ messages }) => ({ text: getMessageText(messages.at(-1)!) }), },
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

  it("exposes generated summaries after later input object replacement", async () => {
    const { chatSummary } = await import("../src/capabilities.ts")
    const { defineCapability } = await import("../src/capability-runtime.ts")
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const replaceInput = defineCapability({
      id: "replace-input",
      input(context) {
        const input = context.input.get()
        context.input.set({ ...input, context: { ...input.context, replaced: true } })
      },
    })
    const agent = defineAgent({
      capabilities: [chatSummary({ execute: () => "Summary for finish hook." }), replaceInput],
      hooks: {
        "agent:finish": finish,
      },
      driver: { run: ({ messages }) => ({ text: getMessageText(messages.at(-1)!) }), },
    })

    await runAgent(agent, runtime(), {
      messages: [
        createMessage({ role: "user", text: "Original request" }),
        createMessage({ role: "user", text: "/summary" }),
      ],
    })

    expect(finish.mock.calls[0]![0].extensions.get("chat-summary")).toEqual({
      summary: "Summary for finish hook.",
    })
  })

  it("does not expose pre-populated summary context as this capability instance result", async () => {
    const { chatSummary } = await import("../src/capabilities.ts")
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const agent = defineAgent({
      capabilities: [chatSummary()],
      hooks: {
        "agent:finish": finish,
      },
      driver: { run: () => ({ text: "ok" }), },
    })

    await runAgent(agent, runtime(), {
      context: { chatSummary: { summary: "External summary." } },
      messages: [createMessage({ role: "user", text: "No command here" })],
    })

    expect(finish.mock.calls[0]![0].extensions.get("chat-summary")).toBeUndefined()
  })

  it("does not expose pre-populated scoped summary context as this run result", async () => {
    const { chatSummary } = await import("../src/capabilities.ts")
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const agent = defineAgent({
      capabilities: [chatSummary()],
      hooks: {
        "agent:finish": finish,
      },
      driver: { run: () => ({ text: "ok" }), },
    })

    await runAgent(agent, runtime(), {
      context: { "chat-summary:summary": { summary: "External summary." } },
      messages: [createMessage({ role: "user", text: "No command here" })],
    })

    expect(finish.mock.calls[0]![0].extensions.get("chat-summary")).toBeUndefined()
  })

  it("does not expose a generated summary reused by a later run", async () => {
    const { chatSummary } = await import("../src/capabilities.ts")
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const agent = defineAgent({
      capabilities: [chatSummary({ execute: () => "Generated summary." })],
      hooks: {
        "agent:finish": finish,
      },
      driver: { run: () => ({ text: "ok" }), },
    })

    await runAgent(agent, runtime(), {
      messages: [createMessage({ role: "user", text: "/summary" })],
    })
    const generatedSummary = finish.mock.calls[0]![0].extensions.get("chat-summary")
    expect(generatedSummary).toEqual({ summary: "Generated summary." })

    await runAgent(agent, runtime(), {
      context: { "chat-summary:summary": generatedSummary },
      messages: [createMessage({ role: "user", text: "No command here" })],
    })

    expect(finish.mock.calls[1]![0].extensions.get("chat-summary")).toBeUndefined()
  })
})
