import { resolve } from "node:path"
import { defineConfig } from "vite"
import { hubSandboxTask } from "@vite-hub/sandbox-task/vite"

export default defineConfig({
  appType: "custom",
  build: {
    ssr: true,
    rolldownOptions: {
      input: resolve(import.meta.dirname, "src/server.ts"),
    },
  },
  plugins: [hubSandboxTask()],
  sandboxTask: {
    provider: "cloudflare",
  },
})
