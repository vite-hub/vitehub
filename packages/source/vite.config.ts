import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    entry: [
      "src/index.ts",
      "src/sources/custom.ts",
      "src/sources/file.ts",
      "src/sources/github.ts",
      "src/sources/glob.ts",
      "src/sources/index.ts",
      "src/sources/markdown.ts",
      "src/sources/mcp-resources.ts",
    ],
    exports: {
      customExports(exports) {
        return Object.fromEntries(
          Object.entries(exports).map(([key, value]) => {
            if (typeof value !== "string" || !value.endsWith(".js")) {
              return [key, value];
            }
            return [
              key,
              {
                types: value.replace(/\.js$/, ".d.ts"),
                import: value,
              },
            ];
          }),
        );
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
