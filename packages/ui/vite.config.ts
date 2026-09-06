import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    copy: [{ from: "styles.css", to: "dist" }],
    deps: {
      alwaysBundle: [/@pierre\//, "@vite-hub/runtime"],
      neverBundle: [
        "#app",
        "@comark/vue",
        /^@comark\/vue\//,
        "@nuxt/kit",
        "@nuxt/ui",
        /^@nuxt\/ui\//,
        "ai",
        "nuxt",
        "vue",
        "vite",
      ],
      onlyBundle: false,
    },
    entry: [
      "src/index.ts",
      "src/headless.ts",
      "src/nuxt.ts",
      "src/runtime/nuxt-plugin.ts",
      "src/vite.ts",
    ],
    exports: {
      customExports(exports) {
        const publicExports = Object.fromEntries(
          Object.entries(exports)
            .filter(([key]) => key !== "./runtime/nuxt-plugin")
            .map(([key, value]) => {
              if (typeof value !== "string" || !value.endsWith(".js")) return [key, value];
              return [key, { types: value.replace(/\.js$/, ".d.ts"), import: value }];
            }),
        );
        return { ...publicExports, "./styles.css": "./dist/styles.css" };
      },
      inlinedDependencies: false,
    },
    outExtensions: () => ({ dts: ".d.ts", js: ".js" }),
    publint: true,
  },
});
