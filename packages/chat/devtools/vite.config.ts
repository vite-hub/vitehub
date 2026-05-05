import { defineConfig } from "vite"

export default defineConfig({
  build: {
    outDir: "dist/client",
  },
  resolve: {
    alias: {
      "@vitehub/chat/devtools": new URL("../src/devtools.ts", import.meta.url).pathname,
    },
  },
})
