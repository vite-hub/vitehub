import { defineConfig } from "vitest/config"

import { testLayerIncludes } from "./test/layers.ts"

export default defineConfig({
  test: {
    environment: "node",
    include: testLayerIncludes.contracts,
  },
})
