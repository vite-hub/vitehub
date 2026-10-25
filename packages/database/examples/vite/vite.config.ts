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
    nitro(),
  ],
})
