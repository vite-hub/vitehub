import { defineConfig } from "vite"

import { hubQueue } from "@vitehub/queue/vite"

export default defineConfig({
  build: {
    outDir: "dist/client",
  },
  plugins: [hubQueue()],
  queue: {},
})
