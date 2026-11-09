import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      host: 'cloudflare',
      workspace: {
        store: {
          provider: 'cloudflare-artifacts',
          binding: 'WORKSPACE_ARTIFACTS',
          namespace: 'vitehub',
        },
      },
    }),
  ],
})
