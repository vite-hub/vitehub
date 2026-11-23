export default defineNuxtConfig({
  modules: ["vite-hub/nuxt"],
  vitehub: {
    auth: true,
    database: true,
    email: true,
    kv: true,
    queue: true,
    schedule: true,
  },
})
