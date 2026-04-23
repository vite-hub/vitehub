import { resolve } from "node:path"

import { defineConfig } from "vite"

import { hubBlob } from "@vitehub/blob/vite"
import { hubKv } from "@vitehub/kv/vite"
import { hubQueue } from "@vitehub/queue/vite"

const buildMode = process.env.VITEHUB_VITE_MODE || "queue"
const blobOnly = buildMode === "blob"
const input = blobOnly ? "src/server.blob.ts" : "src/server.ts"

export default defineConfig({
  appType: "custom",
  build: {
    outDir: "dist/client",
    rollupOptions: {
      input: resolve(import.meta.dirname, input),
    },
  },
  plugins: blobOnly ? [hubBlob()] : [hubQueue(), hubKv()],
  ...(blobOnly ? { blob: {} } : { queue: {} }),
})
