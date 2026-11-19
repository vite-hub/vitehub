export default defineNuxtConfig({
  modules: ['@nuxthub/core', 'vite-hub/nuxt', '@nuxt/ui'],

  routeRules: {
    '/blog/**': { prerender: true },
  },

  hub: {
    db: 'sqlite',
  },

  compatibilityDate: '2026-09-03',
  vitehub: {
    host: 'node',
  },
})
