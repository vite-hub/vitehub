import { createMockAgentAdapter } from "@vitehub/agent/test"
import { defineChat } from "@vitehub/agent/chat"
import { createMemoryChatStateAdapter } from "@vitehub/agent/chat/runtime/memory-state"

const adapter = createMockAgentAdapter({
  delay: 650,
  name: "playground-mock",
  tools: [
    {
      id: "inspect-workspace",
      input: { command: "rg -n \"devtools|agent\" server packages --glob '*.ts'" },
      name: "shell",
      output: {
        exitCode: 0,
        stderr: "",
        stdout: [
          "server/chat.ts:1:exports the deterministic DevTools Demo Agent",
          "packages/agent/src/chat/agent-handoff.ts:149:reports Agent tool steps to Chat DevTools",
          "packages/devtools/devtools/chat/app/app.vue:tool stream renders inside the reasoning panel",
        ].join("\n"),
      },
    },
    {
      id: "read-context",
      input: { path: ".agents/contexts/devtools/CONTEXT.md" },
      name: "read_file",
      output: {
        bytes: 428,
        summary: "DevTools Feature metadata is discovered by the hosted shell and Chat owns its DevTools Bridge behavior.",
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
      "The shell and file reads above are mocked, but they are streamed through the real Agent, Chat, and DevTools bridge path.",
      "This keeps the demo stable and token-free while still exercising the hosted ViteHub DevTools Feature.",
    ].join(" ")
  },
})

const agent = {
  chat: {
    fallbackStreamingPlaceholderText: "Thinking...",
    history: { maxMessages: 8, source: "thread" },
    state: createMemoryChatStateAdapter(),
  },
  async resolve() {
    return adapter
  },
}

export default defineChat({
  adapters: {},
  agent: {
    definition: agent,
    name: "playground-devtools-demo",
  },
  fallbackStreamingPlaceholderText: "Thinking...",
  state: createMemoryChatStateAdapter(),
  userName: "vite-playground",
})
