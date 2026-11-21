export default defineNuxtConfig({
  modules: ['@nuxt/content', '@nuxt/ui'],

  content: {
    build: { markdown: { toc: { depth: 3 } } },
  },

  compatibilityDate: '2026-09-03',
})
