import { hubBlob } from "@vite-hub/blob/vite"
import { defineConfig } from "vite"

export default defineConfig({
  blob: {
    access: "private",
    driver: "vercel-blob",
    token: "vercel_blob_rw_test",
  },
  build: {
    outDir: "dist/client",
    rollupOptions: { input: "src/server.ts" },
    ssr: "src/server.ts",
  },
  plugins: [hubBlob()],
})
