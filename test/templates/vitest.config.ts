import { resolve } from "node:path"

import { defineConfig } from "vitest/config"

import { testLayerIncludes } from "../layers.ts"

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    hookTimeout: 900_000,
    include: testLayerIncludes.templates,
    root: resolve(import.meta.dirname, "../.."),
    testTimeout: 120_000,
  },
})
