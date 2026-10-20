import { hubBlob } from "@vite-hub/blob/vite"
import { defineConfig } from "vite"

export default defineConfig({
  blob: {
    access: "private",
    driver: "vercel-blob",
    token: "vercel_blob_rw_test",
  },
  build: {
    outDir: "dist/vercel",
    rolldownOptions: { output: { entryFileNames: "server.mjs" } },
    ssr: ".vitehub/nitro/blob/runtime.mjs",
  },
  nitro: { preset: "vercel" },
  plugins: [
    { name: "nitro:main" },
    hubBlob(),
  ],
  ssr: { noExternal: true },
})
