import { vitehub } from "vite-hub"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [
    vitehub({ preset: "node" }),
  ],
})
