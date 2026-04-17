import { defineConfig } from "vite"
import { hubQueue } from "@vitehub/queue/vite"

export default defineConfig({
  plugins: [hubQueue()],
  queue: {
    provider: "memory",
  },
})
