import { resolve } from "node:path"
import { defineConfig } from "vite"

import { hubDb } from "@vitehub/database/vite"

export default defineConfig({
  appType: "custom",
  build: {
    rollupOptions: {
      input: resolve(import.meta.dirname, "src/server.ts"),
    },
  },
  plugins: [hubDb()],
})
