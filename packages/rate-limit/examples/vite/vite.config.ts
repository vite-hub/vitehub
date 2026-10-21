import { hubRateLimit } from "@vite-hub/rate-limit/vite"
import { nitro } from "nitro/vite"
import { defineConfig } from "vite"

export default defineConfig({
  nitro: {
    preset: "cloudflare-module",
    serverEntry: "./src/server.ts",
  },
  plugins: [
    hubRateLimit({ namespace: "rate-limit-showcase" }),
    // SAFETY: Nitro's Vite plugin is runtime-compatible with this Vite version despite its prerelease type identity.
    nitro() as never,
  ],
})
