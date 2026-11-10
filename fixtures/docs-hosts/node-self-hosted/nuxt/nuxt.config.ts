export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    preset: 'node',
    kv: {
      driver: 'fs-lite',
      base: '.vitehub/data/kv',
    },
  },
})
