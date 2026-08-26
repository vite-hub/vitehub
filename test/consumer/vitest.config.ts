import { resolve } from "node:path"

import { defineConfig } from "vitest/config"

import { testLayerIncludes } from "../layers.ts"

export default defineConfig({
  test: {
    environment: "node",
    env: {
      VITEHUB_CONSUMER_CONTRACT: "1",
    },
    include: testLayerIncludes.consumer,
    root: resolve(import.meta.dirname, "../.."),
  },
})
