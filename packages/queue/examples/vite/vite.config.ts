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
    // SAFETY: Nitro's Vite plugin is runtime-compatible with this Vite version despite its prerelease type identity.
    nitro() as never,
  ],
  queue: {
    provider: "vercel",
    region: "fra1",
  },
})
