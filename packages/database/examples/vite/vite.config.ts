import { defineConfig } from "vite"
import { nitro } from "nitro/vite"

import { hubDb } from "@vite-hub/database/vite"

export default defineConfig({
  nitro: {
    preset: "cloudflare-module",
    serverEntry: "./src/server.ts",
  },
  plugins: [
    hubDb(),
    // SAFETY: Nitro's Vite plugin is runtime-compatible with this Vite version despite its prerelease type identity.
    nitro() as never,
  ],
})
