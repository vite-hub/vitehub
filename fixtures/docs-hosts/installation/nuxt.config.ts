import viteHubNuxt from "vite-hub/nuxt"

export default defineNuxtConfig({
  modules: [
    [viteHubNuxt, { preset: "node" }],
  ],
})
