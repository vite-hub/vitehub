import viteHubNuxt from "vite-hub/nuxt"

export default defineNuxtConfig({
  buildDir: ".nuxt",
  modules: [
    [viteHubNuxt, { preset: "node" }],
  ],
})
