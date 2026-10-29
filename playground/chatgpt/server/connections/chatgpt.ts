import { defineConnection } from "vite-hub/connections"
import { chatgpt } from "vite-hub/connections/chatgpt"

export default defineConnection({
  provider: chatgpt({ appName: "ViteHub ChatGPT playground", appVersion: "0.0.4" }),
  access: { "agent:assistant": { read: true } },
})
