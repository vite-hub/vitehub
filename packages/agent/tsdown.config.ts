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
    "src/capabilities.ts",
    "src/chat/devtools.ts",
    "src/chat/runtime/agent-chat.ts",
    "src/chat/runtime/chat-devtools-handler.ts",
    "src/chat/runtime/workspace-state.ts",
    "src/index.ts",
    "src/cloudflare.ts",
    "src/nitro.ts",
    "src/runtime/empty-registry.ts",
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
