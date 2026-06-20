import { defineConfig } from "vite-plus"

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    deps: {
      neverBundle: [
        "vite",
        /^@vite-hub\/(?:agent|blob|database|devtools|env|kv|queue|sandbox|schedule|workflow|workspace)(?:\/.*)?$/,
      ],
      onlyBundle: false,
    },
    entry: [
      "src/agent.ts",
      "src/agent/capabilities.ts",
      "src/agent/channels.ts",
      "src/index.ts",
    ],
    exports: {
      inlinedDependencies: false,
    },
    outExtensions: () => ({
      dts: ".d.ts",
      js: ".js",
    }),
    publint: true,
  },
})
