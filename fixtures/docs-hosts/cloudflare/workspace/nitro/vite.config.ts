import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      preset: 'cloudflare',
      workspace: {
        store: {
          provider: 'cloudflare-artifacts',
          binding: 'WORKSPACE_ARTIFACTS',
          namespace: 'vitehub',
        },
      },
    }),
    nitro(),
  ],
})
