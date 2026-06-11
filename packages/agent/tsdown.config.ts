import { defineConfig } from "tsdown"

export default defineConfig({
  clean: true,
  deps: {
    alwaysBundle: [/^@vite-hub\/(devtools|internal)/],
    neverBundle: ["#vitehub/agent/registry", "@vercel/nft", "cloudflare:workers", /^@chat-adapter\/telegram$/, /^evalite/, /^vitest/],
    onlyBundle: false,
  },
  dts: true,
  entry: [
    "src/ai-sdk.ts",
    "src/capabilities.ts",
    "src/capability-runtime.ts",
    "src/index.ts",
    "src/memory.ts",
    "src/messages.ts",
    "src/mcp.ts",
    "src/mcp/stdio.ts",
    "src/cloudflare.ts",
    "src/cli.ts",
    "src/eval.ts",
    "src/state/sqlite.ts",
    "src/cloudflare/state.ts",
    "src/runtime/empty-registry.ts",
    "src/runtime/workflow.ts",
    "src/server.ts",
    "src/test.ts",
    "src/vercel.ts",
    "src/vite.ts",
  ],
  exports: {
    inlinedDependencies: false,
  },
  format: ["esm"],
  outExtensions: () => ({
    dts: ".d.ts",
    js: ".js",
  }),
  publint: true,
})
