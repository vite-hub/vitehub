import viteHub from "vite-hub/nuxt";

export default defineNuxtConfig({
  buildDir: ".nuxt",
  modules: ["@nuxt/ui", [viteHub, {
    agent: true,
    console: false,
  }]],
  css: ["~/assets/main.css"],
  ui: { fonts: false },
  devtools: { enabled: false },
});
