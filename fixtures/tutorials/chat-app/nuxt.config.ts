import viteHub from "vite-hub/nuxt";

export default defineNuxtConfig({
  buildDir: ".nuxt",
  modules: ["@nuxt/ui", "@vite-hub/ui/nuxt", [viteHub, {
    preset: "node",
    agent: true,
    workflow: false,
    console: false,
  }]],
  css: ["~/assets/main.css"],
  ui: { fonts: false },
  devtools: { enabled: false },
});
