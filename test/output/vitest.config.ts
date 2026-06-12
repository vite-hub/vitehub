import { resolve } from "node:path"

import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/output/**/*.test.ts"],
    root: resolve(import.meta.dirname, "../.."),
  },
})
