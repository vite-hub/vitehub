import { defineConfig } from "vitest/config"
import vue from "@vitejs/plugin-vue"

import { standaloneUI } from "../ui/src/standalone/vite.ts"

export default defineConfig({
  // Tests that mount the comments overlay build its parts the way the overlay build does.
  plugins: [vue(), standaloneUI()],
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
