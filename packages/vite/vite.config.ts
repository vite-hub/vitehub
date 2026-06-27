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
      "src/agent/eval.ts",
      "src/agent/harness/local-sandbox.ts",
      "src/agent/mcp.ts",
      "src/agent/server.ts",
      "src/agent/state/sqlite.ts",
      "src/database.ts",
      "src/database/drizzle.ts",
      "src/env/vite.ts",
      "src/index.ts",
      "src/workflow.ts",
      "src/workspace.ts",
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
