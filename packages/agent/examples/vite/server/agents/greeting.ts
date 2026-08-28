import { defineAgent } from "@vite-hub/agent"

export default defineAgent({
  description: "Returns a deterministic greeting without a model or provider.",
  runtime: false,
  driver: {
    run({ messages, prompt }) {
      const latestMessage = messages.findLast(message => message.role === "user")
      const latestText = latestMessage?.parts.find(part => part.type === "text")?.text
      const name = (prompt || latestText)?.trim() || "friend"

      return {
        text: `Hello, ${name}. This Agent ran without credentials.`,
      }
    },
  },
})
