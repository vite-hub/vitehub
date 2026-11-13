import { defineConfig } from "vite"
import { vitehub } from "vite-hub"

export default defineConfig({
  plugins: [
    vitehub({
      host: "node",
      kv: { driver: "fs-lite", base: ".vitehub/data/kv" },
    }),
  ],
})
