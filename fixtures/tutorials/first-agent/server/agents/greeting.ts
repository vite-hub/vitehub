import { defineAgent } from "vite-hub/agent"

export default defineAgent({
  driver: {
    run({ prompt }) {
      const name = typeof prompt === "string" ? prompt : "friend"

      return {
        text: `Hello, ${name}. This result came from an Agent Invocation.`,
      }
    },
  },
})
