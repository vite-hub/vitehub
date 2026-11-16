import { defineConfig } from "vite"
import { vitehub } from "vite-hub"

export default defineConfig({
  plugins: [
    vitehub({
      host: "node",
      agent: { channels: { simulate: true } },
      workflow: false,
    }),
  ],
})
