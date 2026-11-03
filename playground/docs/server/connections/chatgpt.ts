import { defineConnection } from "vite-hub/connections"
import { chatgpt } from "vite-hub/connections/chatgpt"

export default defineConnection({
  provider: chatgpt({ appName: "Lumen docs", appVersion: "0.0.0" }),
  access: { "agent:docs": { read: true } },
})
