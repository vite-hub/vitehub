import { defineAgent } from "vite-hub/agent"

export default defineAgent({
  description: "Returns a fixed greeting.",
  runtime: false,
  driver: {
    run({ prompt }) {
      return { text: `Hello, ${typeof prompt === "string" ? prompt : "friend"}.` }
    },
  },
})
