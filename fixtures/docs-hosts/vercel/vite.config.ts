import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      preset: 'vercel',
      blob: true,
      queue: true,
    }),
    // SAFETY: Nitro's Vite plugin is runtime-compatible with this Vite version despite its prerelease type identity.
    nitro() as never,
  ],
})
