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
      workspace: true,
    }),
    // SAFETY: Nitro's Vite plugin is runtime-compatible with this Vite version despite its prerelease type identity.
    nitro() as never,
  ],
  nitro: { serverDir: "./server" },
})
