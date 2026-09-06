import { resolve } from "node:path"

import { hubRateLimit } from "@vite-hub/rate-limit/vite"
import { defineConfig } from "vite"

export default defineConfig({
  appType: "custom",
  build: {
    ssr: true,
    rolldownOptions: {
      input: resolve(import.meta.dirname, "src/server.ts"),
    },
  },
  plugins: [hubRateLimit({ namespace: "rate-limit-showcase", provider: "cloudflare" })],
})
