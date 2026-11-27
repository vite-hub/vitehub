import { defineConfig } from "vitest/config"

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
