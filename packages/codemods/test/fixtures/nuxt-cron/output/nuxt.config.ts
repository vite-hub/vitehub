export default defineNuxtConfig({
  modules: ["@nuxtjs/sitemap", "vite-hub/nuxt"],
  nitro: { preset: "node-server" },
  vitehub: {
    host: "node",
    schedule: { runtime: { driver: "process" } },
    kv: true,
  },
});
