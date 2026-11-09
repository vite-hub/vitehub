export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'deno',
    agent: true,
    console: false,
    workflow: false,
    kv: {
      driver: 'deno-kv',
    },
  },
})
