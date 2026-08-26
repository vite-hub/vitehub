import { resolve } from "node:path"
import { defineConfig } from "vite"

import { hubWorkflow } from "@vite-hub/workflow/vite"

export default defineConfig({
  appType: "custom",
  build: {
    ssr: true,
    rollupOptions: {
      input: resolve(import.meta.dirname, "src/server.ts"),
    },
  },
  plugins: [hubWorkflow()],
  workflow: {
    provider: "vercel",
  },
})
