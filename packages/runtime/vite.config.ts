import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    entry: ["src/drain.ts", "src/index.ts", "src/node.ts"],
    exports: {
      bin: {
        "vitehub-drain": "src/drain.ts",
      },
      customExports(exports) {
        delete exports["./drain"]
        return exports
      },
      inlinedDependencies: false,
    },
    outExtensions: () => ({
      dts: ".d.ts",
      js: ".js",
    }),
    publint: true,
  },
});
