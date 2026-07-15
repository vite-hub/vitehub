import { defineConfig } from "vite-plus"

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    deps: {
      neverBundle: [
        "vite",
        /^@vite-hub\/(?:agent|blob|database|devtools|email|env|kv|queue|sandbox|schedule|workflow|workspace)(?:\/.*)?$/,
      ],
      onlyBundle: false,
    },
    entry: ["src/index.ts"],
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
