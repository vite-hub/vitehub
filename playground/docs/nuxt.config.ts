export default defineNuxtConfig({
  modules: [
    // Listed here so Nuxt installs its module dependencies, such as @nuxt/icon. A module that another module installs
    // with installModule() does not get them.
    "@nuxt/ui",
    ["vite-hub/nuxt", { preset: "node", agent: true, connections: true, database: true, workflow: false }],
    "@vite-hub/docs/nuxt",
  ],
  docs: {
    site: { name: "Lumen" },
    // Uses the Agent in server/agents/docs.ts.
    assistant: true,
  },
  devtools: { enabled: false },
  compatibilityDate: "2026-10-01",
})
