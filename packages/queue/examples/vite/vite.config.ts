import { resolve } from "node:path"
import { defineConfig } from "vite"

import { hubQueue } from "@vitehub/queue/vite"

export default defineConfig({
  appType: "custom",
  build: {
    rollupOptions: {
      input: resolve(import.meta.dirname, "src/server.ts"),
    },
  },
  plugins: [hubQueue()],
  queue: {
    provider: "vercel",
    region: "fra1",
  },
})
