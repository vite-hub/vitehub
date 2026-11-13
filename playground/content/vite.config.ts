import { nitro } from "nitro/vite"
import { defineConfig } from "vite"
import { vitehub } from "vite-hub"

// Content with app Auth. `content.authorize` in `server/content.ts` decides who may read, write, and publish.
// `console: { auth: false }` lets the `vitehub` commands call this dev server without a signature.
export default defineConfig({
  plugins: [
    vitehub({
      host: "node",
      // `server/agents/translator.ts` translates English docs pages. `server/queues/translate.ts` runs it after each change.
      agent: true,
      auth: true,
      // `serve` exposes stored images at /api/_vitehub/blob, so SEO previews and social cards can show them.
      blob: { driver: "fs", base: ".vitehub/data/blob", serve: { public: true } },
      database: true,
      console: { auth: false },
      kv: { driver: "fs-lite", base: ".vitehub/data/kv" },
      queue: true,
      // Content edits posts live in one Node process. `vite dev` uses the memory authority; a Node build needs
      // `realtime: { authority: "memory" }`, and hosts without a room authority keep one editor at a time.
      realtime: true,
      // `server/schedules/content-publish.ts` runs scheduled Content publishes in this process every minute.
      schedule: { runtime: { driver: "process" } },
      workspace: true,
    }),
    nitro(),
  ],
  nitro: { serverDir: "./server" },
})
