import { nitro } from "nitro/vite"
import { defineConfig } from "vite"
import { vitehub } from "vite-hub"

// Content editing in the Console with app Auth. `server/console-authorize.ts` limits editors to the Content section,
// and `content.authorize` in `server/content.ts` decides who may read, write, and publish.
export default defineConfig({
  plugins: [
    vitehub({
      preset: "node",
      auth: true,
      // `serve` exposes stored images at /api/_vitehub/blob, so SEO previews and social cards can show them.
      blob: { driver: "fs", base: ".vitehub/data/blob", serve: true },
      database: true,
      console: { auth: "app", authorize: "./server/console-authorize.ts" },
      kv: { driver: "fs-lite", base: ".vitehub/data/kv" },
      // Content edits posts live in one Node process. `vite dev` uses the memory authority; a Node build needs
      // `realtime: { authority: "memory" }`, and hosts without a room authority keep one editor at a time.
      realtime: true,
      // `server/schedules/content-publish.ts` runs scheduled Content publishes in this process every minute.
      schedule: { runtime: { driver: "process" } },
      workspace: true,
    }),
    // SAFETY: Nitro's Vite plugin is runtime-compatible with this Vite version despite its prerelease type identity.
    nitro() as never,
  ],
  nitro: { serverDir: "./server" },
})
