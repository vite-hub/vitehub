import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    deps: {
      neverBundle: ["vite"],
      onlyBundle: false,
    },
    entry: ["src/index.ts", "src/chat-shared.ts"],
    exports: {
      inlinedDependencies: false,
    },
    outExtensions: () => ({
      dts: ".d.ts",
      js: ".js",
    }),
    publint: true,
  },
});
