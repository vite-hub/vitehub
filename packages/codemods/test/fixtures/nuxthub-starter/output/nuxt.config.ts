// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  modules: [
    'vite-hub/nuxt',
    '@nuxt/eslint',
  ],
  devtools: { enabled: true },
  compatibilityDate: '2025-12-11',

  vitehub: {
    host: 'cloudflare',
    database: true,
    kv: { driver: 'cloudflare', binding: 'KV', namespaceId: 'ba6f3913de344cb1a833f3cf20ba5aa8' },
    blob: { driver: 'cloudflare', binding: 'BLOB', bucketName: 'hub-starter-p2s5' },
    cache: { driver: 'cloudflare', binding: 'CACHE', namespaceId: 'ba6f3913de344cb1a833f3cf20ba5aa8' },
  },

  eslint: {
    config: {
      stylistic: true,
    },
  },
})
