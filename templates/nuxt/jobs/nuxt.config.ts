import tailwindcss from "@tailwindcss/vite"

export default defineNuxtConfig({
  modules: ["vite-hub/nuxt", "@ui-sdk/vue/nuxt", "@vite-hub/kit/nuxt"],
  css: ["~/assets/css/main.css"],
  vite: { plugins: [tailwindcss()] },
  compatibilityDate: "2026-11-01",
})
