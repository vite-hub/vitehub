import { defineConfig } from "vitest/config"
import { fileURLToPath } from "node:url"

import vue from "@vitejs/plugin-vue"

import { standaloneUI } from "../ui/src/standalone/vite.ts"
import frameworkPackageManifest from "./package.json" with { type: "json" }

export default defineConfig({
  define: { __VITE_HUB_VERSION__: JSON.stringify(frameworkPackageManifest.version) },
  // Tests that mount the comments overlay build its parts the way the overlay build does.
  plugins: [vue(), standaloneUI()],
  resolve: {
    alias: [
      { find: /^@vite-hub\/ui\/comments$/, replacement: fileURLToPath(new URL("../ui/src/comments.ts", import.meta.url)) },
      { find: /^@vite-hub\/ui\/standalone\/(.+)$/, replacement: `${fileURLToPath(new URL("../ui/src/standalone", import.meta.url))}/$1` },
    ],
  },
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
