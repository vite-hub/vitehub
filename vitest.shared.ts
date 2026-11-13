import { defineConfig } from "vitest/config"

// Test configs that several packages share. A package with other needs keeps its own `vitest.config.ts`.

export const nodeTests = defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
})

export const nodeAndTypeTests = defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    typecheck: {
      enabled: true,
      include: ["test/**/*.test-d.ts"],
    },
  },
})

export const serialNodeAndTypeTests = defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    include: ["test/**/*.test.ts"],
    typecheck: {
      enabled: true,
      include: ["test/**/*.test-d.ts"],
    },
  },
})
