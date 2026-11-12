export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    kv: { driver: 'cloudflare', namespaceName: 'app-kv' },
    queue: { driver: 'cloudflare' },
  },
})
