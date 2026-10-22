import { defineConfig } from "vite"
import { vitehub } from "vite-hub"

export default defineConfig({
  root: import.meta.dirname,
  // Nitro scans server/ for api routes only when serverDir is set.
  nitro: { serverDir: "server" },
  plugins: [vitehub({
    preset: "node",
    agent: true,
    blob: false,
    env: false,
  })],
})
