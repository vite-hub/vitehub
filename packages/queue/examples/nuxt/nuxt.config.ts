export default defineNuxtConfig({
  modules: ["@vitehub/queue/nuxt"],
  queue: {
    provider: "memory",
  },
})
