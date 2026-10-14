import { defineConfig } from "vite-plus"

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    deps: {
      alwaysBundle: [/^@vite-hub\/internal/],
      neverBundle: ["@valibot/to-json-schema", "@vite-hub/blob", /^@vite-hub\/blob\//, "@vite-hub/runtime", /^@vite-hub\/runtime\//, "@vite-hub/source", /^@vite-hub\/source\//, "@vite-hub/workspace", "comark-content", /^comark-content\//, "comark", /^comark\//, "comark-tiptap", /^comark-tiptap\//, /^@tiptap\//, "@vite-hub/realtime", /^@vite-hub\/realtime\//, "diff", "drizzle-orm", /^drizzle-orm\//, "vite", "yaml"],
      onlyBundle: false,
    },
    entry: ["src/cli.ts", "src/client.ts", "src/database.ts", "src/editor.ts", "src/index.ts", "src/realtime.ts", "src/runtime/console.ts", "src/runtime/dev.ts", "src/vite.ts"],
    exports: {
      customExports(exports) {
        return Object.fromEntries(Object.entries(exports).map(([key, value]) => {
            if (String(value) !== value || !value.endsWith(".js")) return [key, value]
            return [key, { types: value.replace(/\.js$/, ".d.ts"), import: value }]
          }))
      },
      inlinedDependencies: false,
    },
    outExtensions: () => ({
      dts: ".d.ts",
      js: ".js",
    }),
    publint: true,
  },
})
