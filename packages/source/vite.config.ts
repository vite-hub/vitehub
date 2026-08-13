import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    deps: {
      alwaysBundle: [
        /^@modelcontextprotocol\/sdk(?:\/|$)/,
        /^@vite-hub\/internal/,
        "effect",
        "mrmime",
        "ocache",
        "picomatch",
        "tinyglobby",
      ],
    },
    entry: [
      "src/index.ts",
      "src/file.ts",
      "src/github.ts",
      "src/glob.ts",
      "src/markdown.ts",
      "src/mcp.ts",
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
