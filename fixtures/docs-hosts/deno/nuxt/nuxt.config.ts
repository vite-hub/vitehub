export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    preset: 'deno',
    agent: true,
    console: false,
    workflow: false,
    kv: {
      driver: 'deno-kv',
    },
  },
})
