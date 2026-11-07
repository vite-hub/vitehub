import { defineConnection } from "vite-hub/connections"
import { chatgpt } from "vite-hub/connections/chatgpt"

// The ChatGPT grant of the docs assistant. Only the `docs` Agent may use it.
export default defineConnection({
  provider: chatgpt({ appName: "Lumen docs", appVersion: "1.0.0" }),
  access: { "agent:docs": { read: true } },
})
