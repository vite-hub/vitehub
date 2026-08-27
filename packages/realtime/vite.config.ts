import { defineConfig } from "vite-plus"

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    deps: {
      alwaysBundle: [/^@tiptap\/y-tiptap/, /^@vite-hub\/internal/, /^prosemirror-transform$/],
      neverBundle: ["vite"],
      onlyBundle: false,
    },
    entry: [
      "src/index.ts",
      "src/server.ts",
      "src/vite.ts",
      "src/vue.ts",
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
