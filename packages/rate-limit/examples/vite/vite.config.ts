import { hubRateLimit } from "@vite-hub/rate-limit/vite"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [hubRateLimit({ provider: "cloudflare" })],
})
