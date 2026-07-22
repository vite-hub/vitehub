import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    deps: {
      alwaysBundle: [/^@vite-hub\/internal/],
      neverBundle: [
        "vite",
        "#vitehub-sandbox-provider-loader",
        "#vitehub-sandbox-registry",
        "@vite-hub/sandbox/runtime/provider-loader",
        "vitehub-sandbox-provider-loader",
        "virtual:vitehub-sandbox-provider-loader",
      ],
      onlyBundle: false,
    },
    entry: [
      "src/index.ts",
      "src/vite.ts",
      "src/runtime/empty-registry.ts",
      "src/runtime/provider-loader.ts",
      "src/runtime/providers/cloudflare.ts",
      "src/runtime/providers/vercel.ts",
      "src/runtime/state.ts",
    ],
    exports: {
      customExports(exports) {
        return Object.fromEntries(
          Object.entries(exports).map(([key, value]) => {
            const exportKey = key;
            if (typeof value !== "string" || !value.endsWith(".js")) {
              return [exportKey, value];
            }
            return [
              exportKey,
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
