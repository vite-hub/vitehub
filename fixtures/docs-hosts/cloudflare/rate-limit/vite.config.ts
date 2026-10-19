import { hubRateLimit } from '@vite-hub/rate-limit/vite'
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  nitro: { preset: 'cloudflare-module' },
  plugins: [
    hubRateLimit({ namespace: 'acme-image-service-production' }),
    // SAFETY: Nitro's Vite plugin is runtime-compatible with this Vite version despite its prerelease type identity.
    nitro() as never,
  ],
})
