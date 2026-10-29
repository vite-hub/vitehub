import { defineConfig } from "vitest/config"
import vue from "@vitejs/plugin-vue"

import { overlayPlugin } from "./overlay.vite.config.ts"

export default defineConfig({
  plugins: [vue(), overlayPlugin()],
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    typecheck: {
      enabled: true,
      include: ["test/**/*.test-d.ts"],
      tsconfig: "tsconfig.dev.json",
    },
  },
})
