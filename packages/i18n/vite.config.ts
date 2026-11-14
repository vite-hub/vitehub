import { defineConfig } from "vite-plus"

import { packDefaults } from "@vite-hub/internal/package-exports"

export default defineConfig({
  pack: {
    ...packDefaults,
    copy: [{ from: "src/virtual.d.ts", to: "dist" }],
    deps: {
      neverBundle: ["vite", "vue", /^virtual:/, /^@lingui\//, /^@babel\//],
      alwaysBundle: [/^@vite-hub\/internal/],
      onlyBundle: false,
    },
    plugins: [{
      name: "i18n-virtual-declarations",
      generateBundle(_options, bundle) {
        const chunk = bundle["vue.d.ts"]
        if (chunk?.type === "chunk" && !chunk.code.includes("virtual.d.ts")) {
          chunk.code = `/// <reference path="./virtual.d.ts" />\n${chunk.code}`
        }
      },
    }],
    entry: ["src/index.ts", "src/cli.ts", "src/nuxt.ts", "src/runtime.ts", "src/server.ts", "src/vite.ts", "src/vue.ts"],
    publint: true,
  },
})
