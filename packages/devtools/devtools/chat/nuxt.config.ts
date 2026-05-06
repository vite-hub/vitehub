import { resolve } from "node:path"

export default defineNuxtConfig({
  modules: ["@nuxt/ui"],
  ssr: false,
  devtools: {
    enabled: false,
  },
  app: {
    baseURL: "/__vitehub/chat-devtools/",
  },
  css: ["~/assets/css/main.css"],
  compatibilityDate: "2026-05-05",
  nitro: {
    output: {
      publicDir: resolve(__dirname, "../../../chat/dist/devtools-client"),
    },
  },
})
