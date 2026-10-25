import { defineAgent } from "vite-hub/agent";

export default defineAgent({
  runtime: false,
  invocations: false,
  driver: {
    model: () => process.env.CHAT_MODEL || "openai/gpt-4.1-mini",
    instructions: "Answer clearly and briefly. Use the conversation for context.",
    maxRetries: 0,
    execution: { stepLimit: 1, callSettings: { maxOutputTokens: 800 } },
  },
});
