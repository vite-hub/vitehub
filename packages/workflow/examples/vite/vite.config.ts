import { resolve } from "node:path"
import { defineConfig } from "vite"

import { hubWorkflow } from "@vitehub/workflow/vite"

export default defineConfig({
  appType: "custom",
  build: {
    rollupOptions: {
      input: resolve(import.meta.dirname, "src/server.ts"),
    },
  },
  plugins: [hubWorkflow()],
  workflow: {
    provider: "vercel",
  },
})
