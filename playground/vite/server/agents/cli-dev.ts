import { defineAgent } from "@vite-hub/agent"
import { chat, transcribe } from "@vite-hub/agent/capabilities"

import type { AgentAdapter, AgentAdapterResult, AgentAdapterRunContext, MaybePromise, StreamEvent } from "@vite-hub/agent"

interface MockAgentToolStep {
  delay?: number
  id?: string
  input?: unknown
  name: string
  output?: unknown
}

interface MockAgentAdapterOptions {
  delay?: number
  name?: string
  reply?: string | ((context: AgentAdapterRunContext) => MaybePromise<string | AgentAdapterResult>)
  tools?: MockAgentToolStep[]
}

function wait(ms: number | undefined): Promise<void> {
  return ms && ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve()
}

async function resolveMockReply(
  context: AgentAdapterRunContext,
  reply: MockAgentAdapterOptions["reply"],
): Promise<AgentAdapterResult> {
  const value = typeof reply === "function"
    ? await reply(context)
    : reply || "I inspected the deterministic playground context."
  return typeof value === "string" ? { finishReason: "stop", text: value } : value
}

async function* streamMockAgent(
  context: AgentAdapterRunContext,
  options: MockAgentAdapterOptions,
): AsyncIterable<StreamEvent> {
  for (const tool of options.tools || []) {
    const id = tool.id || tool.name
    yield { id, input: tool.input, name: tool.name, type: "tool-call" }
    await wait(tool.delay ?? options.delay)
    yield { id, name: tool.name, output: tool.output, type: "tool-result" }
  }

  const result = await resolveMockReply(context, options.reply)
  await wait(options.delay)
  if (result.text) {
    yield { text: result.text, type: "text-delta" }
  }
  yield { reason: typeof result.finishReason === "string" ? result.finishReason : "stop", type: "finish" }
}

function createPlaygroundMockAgentAdapter(options: MockAgentAdapterOptions = {}): AgentAdapter {
  return {
    name: options.name || "playground-mock",
    async generate(context) {
      return await resolveMockReply(context, options.reply)
    },
    async stream(context) {
      return streamMockAgent(context, options)
    },
  }
}

const adapter = createPlaygroundMockAgentAdapter({
  delay: 650,
  name: "playground-mock",
  tools: [
    {
      id: "inspect-workspace",
      input: { command: "rg -n \"agent|invocation\" server packages --glob '*.ts'" },
      name: "shell",
      output: {
        exitCode: 0,
        stderr: "",
        stdout: [
          "server/agents/cli-dev.ts:1:exports the deterministic CLI Dev Agent",
          "packages/agent/src/index.ts:527:contributes the chat.message trigger",
          "packages/agent/src/vite/invocation-stream-endpoint.ts:1:streams guarded local Agent Invocations",
        ].join("\n"),
      },
    },
    {
      id: "read-guidance",
      input: { path: "AGENTS.md" },
      name: "read_file",
      output: {
        bytes: 512,
        summary: "ViteHub favors agent-first server primitives, obvious APIs, and code or CLI control.",
      },
    },
  ],
  reply: (context) => {
    const latest = context.messages.filter(message => message.role === "user").at(-1)
    const text = latest?.parts
      .filter(part => part.type === "text")
      .map(part => part.text)
      .join("") || "your request"

    return [
      `I handled "${text}" through the deterministic playground agent.`,
      "The shell and file reads above are mocked, but they are streamed through the real Agent and Chat invocation path.",
      "This keeps the fixture stable and token-free while exercising the CLI Dev Loop.",
    ].join(" ")
  },
})

export default defineAgent({
  capabilities: [
    chat({
      concurrency: "queue",
      fallbackStreamingPlaceholderText: ["Thinking...", "Reading the workspace...", "Checking the run context..."],
      triggerHistory: { maxMessages: 8, source: "thread" },
    }),
    transcribe({
      execute: () => "Transcribed playground voice input.",
    }),
  ],
  driver: {
    run: context => adapter.stream!(context as never),
  },
})
