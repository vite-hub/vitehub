export default defineNuxtConfig({
  modules: ["@nuxtjs/sitemap", "nuxt-cron"],
  cron: {
    runOnInit: false,
    timeZone: "UTC+0",
    jobsDir: "cron",
  },
  nitro: { preset: "node-server" },
});
