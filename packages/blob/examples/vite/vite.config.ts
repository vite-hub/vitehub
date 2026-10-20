import { defineConfig } from "vite"
import { nitro } from "nitro/vite"

import { hubBlob } from "@vite-hub/blob/vite"

export default defineConfig({
  nitro: {
    preset: "cloudflare-module",
    serverEntry: "./src/server.ts",
  },
  plugins: [
    hubBlob(),
    // SAFETY: Nitro's Vite plugin is runtime-compatible with this Vite version despite its prerelease type identity.
    nitro() as never,
  ],
  blob: {
    driver: "cloudflare-r2",
    bucketName: "vitehub-blob",
  },
})
