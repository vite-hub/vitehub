export default defineNuxtConfig({
  modules: [
    "@nuxt/ui",
    ["vite-hub/nuxt", { host: "node", agent: true, connections: true, database: true, console: { auth: false } }],
    "@vite-hub/docs/nuxt",
  ],
  docs: {
    site: { name: "Lumen" },
    assistant: true,
  },
  devtools: { enabled: false },
  compatibilityDate: "2026-10-01",
})
