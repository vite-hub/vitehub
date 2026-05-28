import { defineConfig } from "tsdown"

export default defineConfig({
  clean: true,
  deps: {
    alwaysBundle: [/^@vitehub\/(devtools|internal)/],
    neverBundle: ["#vitehub/agent/registry"],
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
    "src/nitro.ts",
    "src/runtime/empty-registry.ts",
    "src/runtime/chat-devtools-handler.ts",
    "src/runtime/nitro-runtime-config.ts",
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
