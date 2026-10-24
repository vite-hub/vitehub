import { resolve } from "node:path"

import { defineConfig } from "vite"
import { hubAgent } from "vite-hub/agent/vite"

export default defineConfig({
  root: import.meta.dirname,
  appType: "custom",
  build: {
    outDir: "dist",
    rolldownOptions: {
      input: resolve(import.meta.dirname, "src/server.ts"),
      output: { entryFileNames: "server.js" },
    },
    ssr: true,
  },
  plugins: [hubAgent()],
  ssr: {
    external: ["vite-hub/agent"],
  },
})
