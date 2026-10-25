import { defineConfig } from "vite"
import { nitro } from "nitro/vite"

import { hubQueue } from "@vite-hub/queue/vite"

export default defineConfig({
  nitro: {
    preset: "vercel",
    serverEntry: "./src/server.ts",
  },
  plugins: [
    hubQueue(),
    nitro(),
  ],
  queue: {
    provider: "vercel",
    region: "fra1",
  },
})
