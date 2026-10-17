import { defineConfig } from "vite"
import { nitro } from "nitro/vite"

import { hubWorkflow } from "@vite-hub/workflow/vite"

export default defineConfig({
  nitro: {
    preset: "vercel",
    serverEntry: "./src/server.ts",
  },
  plugins: [
    hubWorkflow(),
    // SAFETY: Nitro's Vite plugin is runtime-compatible with this Vite version despite its prerelease type identity.
    nitro() as never,
  ],
  workflow: {
    provider: "vercel",
  },
})
