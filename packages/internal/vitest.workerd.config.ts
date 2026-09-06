import { cloudflareTest } from "@cloudflare/vitest-plugin"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [cloudflareTest({})],
  test: {
    globals: true,
    include: ["test/**/*.workerd.ts"],
  },
})
