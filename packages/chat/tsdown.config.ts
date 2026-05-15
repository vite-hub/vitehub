import { defineConfig } from "tsdown"

export default defineConfig({
  clean: true,
  deps: {
    alwaysBundle: [/^@vitehub\/(devtools|internal)/],
    onlyBundle: false,
  },
  dts: true,
  entry: [
    "src/index.ts",
    "src/cli.ts",
    "src/cloudflare.ts",
    "src/devtools.ts",
    "src/nitro.ts",
    "src/presets.ts",
    "src/runtime/nitro-dev-initialize.ts",
    "src/runtime/cloudflare-workers-dev.ts",
    "src/runtime/agent-chat.ts",
    "src/runtime/chat-devtools-handler.ts",
    "src/runtime/memory-state.ts",
    "src/runtime/nitro-runtime-config.ts",
    "src/runtime/nitro-plugin.ts",
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
