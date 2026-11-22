import { nitro } from "nitro/vite"
import { defineConfig } from "vite"
import { vitehub } from "vite-hub"

export default defineConfig({
  plugins: [
    vitehub({
      host: "node",
      agent: true,
      auth: true,
      blob: { driver: "fs", base: ".vitehub/data/blob", serve: { access: "public" } },
      database: true,
      console: { auth: false },
      kv: { driver: "fs-lite", base: ".vitehub/data/kv" },
      queue: true,
      realtime: true,
      schedule: { runtime: { driver: "process" } },
      workspace: true,
    }),
    nitro(),
  ],
  nitro: { serverDir: "./server" },
})
