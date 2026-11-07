import { hubWorkspace } from '@vite-hub/workspace/vite'

export default {
  plugins: [
    hubWorkspace({
      store: {
        driver: 'cloudflare',
        binding: 'WORKSPACE_ARTIFACTS',
        namespace: 'vitehub',
      },
    }),
  ],
}
