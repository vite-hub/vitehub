import { defineConfig } from "vite-plus";
import { normalizePackageExports } from "@vite-hub/internal/package-exports";
import { componentNames, componentEntryName } from "./src/component-entries.ts";

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
      ...new Set(componentNames.map((name) => `src/${componentEntryName(name)}.ts`)),
      "src/index.ts",
      "src/attachment.ts",
      "src/bubble.ts",
      "src/chat.ts",
      "src/chat-message.ts",
      "src/chat-session.ts",
      "src/code-block.ts",
      "src/markdown.ts",
      "src/marker.ts",
      "src/message.ts",
      "src/message-parts.ts",
      "src/prompt-input.ts",
      "src/trace.ts",
      "src/headless.ts",
      "src/nuxt.ts",
      "src/primitive-rail.ts",
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
        const normalized = normalizePackageExports(publicExports);
        for (const key of Object.keys(normalized)) {
          if (key !== "." && key !== "./headless" && key !== "./nuxt" && key !== "./primitive-rail" && key !== "./vite") {
            const entry = normalized[key];
            if (entry && typeof entry === "object") delete entry.require;
          }
        }
        return { ...normalized, "./styles.css": "./dist/styles.css" };
      },
      inlinedDependencies: false,
    },
    outExtensions: () => ({ dts: ".d.ts", js: ".js" }),
    publint: true,
  },
});
