export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    kv: { driver: 'cloudflare-kv-binding', namespaceName: 'app-kv' },
    queue: { provider: 'cloudflare' },
  },
})
