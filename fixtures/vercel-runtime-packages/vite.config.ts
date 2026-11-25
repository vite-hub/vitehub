import { defineConfig } from "vite"
import { vitehub } from "vite-hub"

export default defineConfig({
  root: import.meta.dirname,
  nitro: { serverDir: "server" },
  plugins: [
    vitehub({
      host: "vercel",
      agent: true,
      blob: true,
      workflow: true,
      workspace: true,
    }),
  ],
})
