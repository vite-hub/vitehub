import { resolve } from "node:path"
import { defineConfig } from "vite"

import { hubSchedule } from "@vitehub/schedule/vite"

export default defineConfig({
  appType: "custom",
  build: {
    rollupOptions: {
      input: resolve(import.meta.dirname, "src/server.ts"),
    },
  },
  plugins: [hubSchedule()],
})
