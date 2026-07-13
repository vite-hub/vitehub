import { defineConfig } from "vite-plus"

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    deps: {
      neverBundle: [
        "vite",
        /^@vite-hub\/(?:agent|blob|cli|database|devtools|env|kv|queue|sandbox|schedule|workflow|workspace)(?:\/.*)?$/,
      ],
      onlyBundle: false,
    },
    entry: [
      "src/agent.ts",
      "src/agent/capabilities.ts",
      "src/agent/channels.ts",
      "src/agent/cloudflare.ts",
      "src/agent/eval.ts",
      "src/agent/harness/claude-code.ts",
      "src/agent/harness/codex.ts",
      "src/agent/harness/local-sandbox.ts",
      "src/agent/state/sqlite.ts",
      "src/agent/test.ts",
      "src/blob.ts",
      "src/cli.ts",
      "src/database.ts",
      "src/database/drizzle.ts",
      "src/env.ts",
      "src/index.ts",
      "src/kv.ts",
      "src/queue.ts",
      "src/sandbox.ts",
      "src/schedule.ts",
      "src/schedule/runtime.ts",
      "src/schedule/runtime/driver.ts",
      "src/workflow.ts",
      "src/workspace.ts",
      "src/workspace/runtime.ts",
    ],
    exports: {
      bin: {
        vitehub: "src/cli.ts",
      },
      inlinedDependencies: false,
    },
    outExtensions: () => ({
      dts: ".d.ts",
      js: ".js",
    }),
    publint: true,
  },
})
