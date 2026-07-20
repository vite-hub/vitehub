import { hubBlob } from "@vite-hub/blob/vite"
import { defineConfig } from "vite"

export default defineConfig({
  build: {
    outDir: "dist/cloudflare",
    rollupOptions: {
      external: ["cloudflare:workers"],
      input: ".vitehub/nitro/blob/runtime.mjs",
      output: { entryFileNames: "server.mjs" },
    },
  },
  nitro: { preset: "cloudflare_module" },
  plugins: [
    { name: "nitro:main" },
    hubBlob({ binding: "BLOB", bucketName: "assets", driver: "cloudflare-r2" }),
  ],
})
