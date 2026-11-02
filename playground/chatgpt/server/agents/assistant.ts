import { codexDriver, defineAgent } from "vite-hub/agent"
import { chatgpt } from "vite-hub/gateways"

export default defineAgent({
  runtime: false,
  driver: codexDriver({
    gateway: chatgpt(),
    model: process.env.CHATGPT_MODEL || "gpt-6.1-sol",
    instructions: "Reply with a short greeting. Do not use tools for this playground check.",
  }),
})
