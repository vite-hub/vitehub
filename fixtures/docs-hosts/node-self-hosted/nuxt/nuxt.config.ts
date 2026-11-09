export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'node',
    kv: {
      driver: 'fs-lite',
      base: '.vitehub/data/kv',
    },
  },
})
