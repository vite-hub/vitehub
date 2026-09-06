import { hubWorkspace } from '@vite-hub/workspace/vite'

export default {
  plugins: [
    hubWorkspace({
      store: {
        provider: 'cloudflare-artifacts',
        binding: 'WORKSPACE_ARTIFACTS',
        namespace: 'vitehub',
      },
    }),
  ],
}
