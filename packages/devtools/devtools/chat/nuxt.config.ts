export default defineNuxtConfig({
  modules: ["@nuxt/ui"],
  ssr: false,
  devtools: {
    enabled: false,
  },
  app: {
    baseURL: "/chat/",
  },
  css: ["~/assets/css/main.css"],
  compatibilityDate: "2026-05-05",
})
