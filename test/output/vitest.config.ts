import { resolve } from "node:path"

import { defineConfig } from "vitest/config"

import { testLayerIncludes } from "../layers.ts"

export default defineConfig({
  test: {
    environment: "node",
    include: testLayerIncludes.output,
    root: resolve(import.meta.dirname, "../.."),
  },
})
