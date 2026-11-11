import viteHub from "vite-hub/nuxt";

export default defineNuxtConfig({
  buildDir: ".nuxt",
  modules: ["@nuxt/ui", [viteHub, {
    preset: "node",
    agent: true,
    workflow: false,
    console: false,
  }]],
  css: ["~/assets/main.css"],
  ui: { fonts: false },
  // Use Shiki's inline WebAssembly loader in the Nitro server bundle.
  vite: { resolve: { alias: { "shiki/wasm": "shiki/dist/wasm.mjs" } } },
  devtools: { enabled: false },
});
