import viteHub from "vite-hub/nuxt";

export default defineNuxtConfig({
  buildDir: ".nuxt",
  modules: ["@nuxt/ui", [viteHub, {
    host: "node",
    agent: true,
    workflow: false,
    console: false,
  }]],
  css: ["~/assets/main.css"],
  vite: {
    resolve: {
      alias: [
        // Inline Shiki's WebAssembly for the Nuxt 5 server build.
        { find: /^shiki\/wasm$/, replacement: "@shikijs/engine-oniguruma/wasm-inlined" },
        { find: /^shiki\/dist\/onig\.wasm$/, replacement: "@shikijs/engine-oniguruma/wasm-inlined" },
        { find: /(?:^|[/\\])shiki[/\\]dist[/\\]onig\.wasm$/, replacement: "@shikijs/engine-oniguruma/wasm-inlined" },
      ],
    },
  },
  ui: { fonts: false },
  devtools: { enabled: false },
});
