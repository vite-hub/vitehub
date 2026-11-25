import { defineConfig } from "vitest/config"
import { fileURLToPath } from "node:url"

import vue from "@vitejs/plugin-vue"

import { standaloneUI } from "../ui/src/standalone/vite.ts"

export default defineConfig({
  plugins: [vue(), standaloneUI()],
  resolve: {
    alias: [
      { find: /^#vitehub\/console\/app$/, replacement: fileURLToPath(new URL("./test/fixtures/console-app.ts", import.meta.url)) },
      { find: /^@vite-hub\/ui\/comments$/, replacement: fileURLToPath(new URL("../ui/src/comments.ts", import.meta.url)) },
      { find: /^@vite-hub\/ui\/standalone\/(.+)$/, replacement: `${fileURLToPath(new URL("../ui/src/standalone", import.meta.url))}/$1` },
    ],
  },
  test: {
    maxWorkers: 2,
    testTimeout: 30_000,
    environment: "node",
    include: ["test/**/*.test.ts"],
    typecheck: {
      enabled: true,
      include: ["test/**/*.test-d.ts"],
      tsconfig: "tsconfig.dev.json",
    },
  },
})
