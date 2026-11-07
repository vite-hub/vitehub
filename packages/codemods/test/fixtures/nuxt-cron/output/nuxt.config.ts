export default defineNuxtConfig({
  modules: ["@nuxtjs/sitemap", "vite-hub/nuxt"],
  nitro: { preset: "node-server" },
  vitehub: {
    preset: "node",
    schedule: { runtime: { driver: "process" } },
  },
});
