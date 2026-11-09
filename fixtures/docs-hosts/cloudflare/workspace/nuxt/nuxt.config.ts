export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    preset: 'cloudflare',
    workspace: {
      store: {
        provider: 'cloudflare-artifacts',
        binding: 'WORKSPACE_ARTIFACTS',
        namespace: 'vitehub',
      },
    },
  },
})
