import { resolve } from "node:path"
import { defineConfig } from "vite"
import { hubSandbox } from "@vitehub/sandbox/vite"

export default defineConfig({
  appType: "custom",
  build: {
    rollupOptions: {
      input: resolve(import.meta.dirname, "src/server.ts"),
    },
  },
  plugins: [hubSandbox()],
  sandbox: {
    provider: "cloudflare",
  },
})
