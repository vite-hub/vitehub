import { resolve } from "node:path"

import { defineConfig } from "vite"

import { hubBlob } from "@vitehub/blob/vite"

export default defineConfig({
  appType: "custom",
  build: {
    rollupOptions: {
      input: resolve(import.meta.dirname, "src/server.ts"),
    },
  },
  plugins: [hubBlob()],
  blob: {},
})
