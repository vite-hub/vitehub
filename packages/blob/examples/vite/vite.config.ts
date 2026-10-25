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
    nitro(),
  ],
  blob: {
    driver: "cloudflare-r2",
    bucketName: "vitehub-blob",
  },
})
