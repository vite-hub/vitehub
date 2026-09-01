import ui from "@vite-hub/ui/vite";
import vue from "@vitejs/plugin-vue";
import { resolve } from "node:path";
import { defineConfig } from "vite";

import { consoleAppConfig } from "./src/console/app.config";

const clientRoot = resolve(import.meta.dirname, "src/console/runtime/client");

export default defineConfig({
  base: "/_vitehub/assets/",
  resolve: {
    alias: {
      "vite-hub/agent/vue": resolve(import.meta.dirname, "../agent/src/vue.ts"),
      "vite-hub/source/client": resolve(import.meta.dirname, "../source/src/client.ts"),
      "vue-router": resolve(import.meta.dirname, "node_modules/vue-router"),
    },
    dedupe: ["vue", "vue-router"],
  },
  plugins: [
    vue(),
    ...ui({
      comark: false,
      nuxtUI: {
        dts: false,
        icon: {
          clientBundle: {
            scan: {
              globInclude: ["src/console/**/*.{js,ts,vue}"],
            },
          },
        },
        ui: consoleAppConfig,
      },
    }),
  ],
  build: {
    cssCodeSplit: false,
    emptyOutDir: true,
    outDir: resolve(import.meta.dirname, ".vitehub/console"),
    rollupOptions: {
      input: resolve(clientRoot, "main.js"),
      output: {
        assetFileNames: asset => asset.names.some(name => name.endsWith(".css"))
          ? "console.css"
          : "assets/[name]-[hash][extname]",
        chunkFileNames: "chunks/[name]-[hash].js",
        entryFileNames: "console.js",
      },
    },
  },
});
