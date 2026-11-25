import { defineAgent } from "vite-hub/agent"

export default defineAgent({
  driver: {
    async *run({ messages }) {
      const turns = messages.filter(message => message.role === "user")
      yield { type: "text-delta" as const, text: `Reply ${turns.length}` }
      yield { type: "finish" as const }
    },
  },
})
